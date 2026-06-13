const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
require("dotenv").config(); 
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

// DB connection - Upgraded to Connection Pool
const db = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "root",
    database: process.env.DB_NAME || "disaster_relief_db_final",
    port: process.env.DB_PORT || 3306,
    ssl: {
        rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test the pool connection on startup
db.getConnection((err, connection) => {
    if (err) {
        console.error("Database pool connection error:", err.message);
    } else {
        console.log("Connected to MySQL database via Connection Pool");
        connection.release(); // Release it back to the pool to prevent memory leaks
    }
});

const dbPromise = db.promise();

// Serve frontend files
app.use(express.static(path.join(__dirname, "../Frontend")));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/login.html"));
});

// TEST API
app.get("/test", (req, res) => {
    res.send("Backend working!");
});

// ===== LOGIN API =====
app.post("/login", async (req, res) => {
    const { email, password } = req.body; // Notice we now take a password, not just a role
    try {
        // 1. Find the user in the database
        const [users] = await dbPromise.query("SELECT * FROM users WHERE email = ?", [email]);
        
        if (users.length === 0) {
            return res.status(401).json({ success: false, message: "Invalid email or password" });
        }

        const user = users[0];

        // 2. Compare the typed password with the hashed password in the DB
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ success: false, message: "Invalid email or password" });
        }
        
        // 3. Generate the JWT (The ID Badge)
        const token = jwt.sign(
            { userId: user.user_id, role: user.role, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: "8h" } // Badge expires in 8 hours
        );

        // 4. Send the token and role back to the frontend
        res.json({
            success: true,
            token: token,
            role: user.role,
            email: user.email,
            redirect: getRedirectPath(user.role)
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Health check route for UptimeRobot
app.get('/ping', (req, res) => {
    res.status(200).send('Server is awake and healthy!');
});

// ===== THE MIDDLEWARE BOUNCER =====
function authenticateToken(req, res, next) {
    // The frontend sends the token in the 'Authorization' header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer <token>"

    if (!token) {
        return res.status(401).json({ success: false, message: "Access Denied: No Token Provided" });
    }

    // Verify the badge using your secret key
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: "Invalid or Expired Token" });
        }
        req.user = user; // Attach the user info to the request
        next(); // Let them pass to the API route
    });
}

function getRedirectPath(role) {
    switch(role) {
        case "Admin":
            return "/admin.html";
        case "Inventory Manager":
            return "/inventory_manager.html";
        case "Camp Manager":
            return "/camp_manager.html";
        case "Supplier":
            return "/supplier.html";
        default:
            return "/login.html";
    }
}

app.get("/resources", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT r.resource_id,
                    r.resource_name,
                    r.unit,
                    IFNULL(SUM(s.quantity_available), 0) AS total_available
             FROM resource r
             LEFT JOIN inventory_stock s ON r.resource_id = s.resource_id
             GROUP BY r.resource_id, r.resource_name, r.unit`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).send(err);
    }
});

// ===== SIMPLE RESOURCES API FOR DROPDOWN =====
app.get("/resources-simple", async (req, res) => {
    try {
        const [rows] = await dbPromise.query("SELECT resource_id, resource_name FROM resource");
        res.json(rows);
    } catch (err) {
        res.status(500).json(err);
    }
});

app.get("/inventory-stock", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT s.inv_stock_id,
                    s.quantity_available,
                    s.minimum_threshold,
                    ci.name AS inventory_name,
                    ci.location,
                    r.resource_name
             FROM inventory_stock s
             LEFT JOIN central_inventory ci ON s.inventory_id = ci.inventory_id
             LEFT JOIN resource r ON s.resource_id = r.resource_id
             ORDER BY ci.name, r.resource_name`
        );
        res.json({ success: true, inventory: rows });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.get("/inventory-dashboard", async (req, res) => {
    try {
        const [currentStock] = await dbPromise.query("SELECT IFNULL(SUM(quantity_available), 0) AS totalStock FROM inventory_stock");
        const [incomingSupplies] = await dbPromise.query("SELECT COUNT(*) AS incomingCount FROM supply WHERE supply_date > CURDATE()");
        const [pendingRequests] = await dbPromise.query("SELECT COUNT(*) AS pendingCount FROM resource_request WHERE status = 'PENDING'");
        const [dispatchedToday] = await dbPromise.query("SELECT IFNULL(SUM(quantity_supplied), 0) AS dispatched FROM request_fulfillment WHERE DATE(fulfillment_date) = CURDATE()");

        res.json({
            success: true,
            currentStockCount: currentStock[0].totalStock || 0,
            incomingSuppliesCount: incomingSupplies[0].incomingCount || 0,
            pendingRequestsCount: pendingRequests[0].pendingCount || 0,
            dispatchedTodayCount: dispatchedToday[0].dispatched || 0
        });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.get("/supplier-dashboard", async (req, res) => {
    try {
        const [pendingRequests] = await dbPromise.query("SELECT COUNT(*) AS pendingCount FROM supply WHERE status = 'PENDING'");
        const [activeShipments] = await dbPromise.query("SELECT COUNT(*) AS activeCount FROM supply WHERE status = 'PENDING' AND supply_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)");
        const [deliveredTotal] = await dbPromise.query("SELECT IFNULL(SUM(quantity_supplied), 0) AS deliveredTotal FROM supply WHERE status = 'APPROVED'");

        res.json({
            success: true,
            pendingSupplyRequests: pendingRequests[0].pendingCount || 0,
            activeShipments: activeShipments[0].activeCount || 0,
            deliveredTotal: deliveredTotal[0].deliveredTotal || 0
        });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.get("/supplier-requests", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT sp.supply_id,
                    sp.supply_date,
                    sp.status,
                    r.resource_name,
                    rc.name AS camp_name
             FROM supply sp
             LEFT JOIN resource r ON sp.resource_id = r.resource_id
             LEFT JOIN relief_camp rc ON sp.camp_id = rc.camp_id
             WHERE sp.supply_date >= CURDATE()
             ORDER BY sp.supply_date ASC`
        );
        res.json({ success: true, requests: rows });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.get("/supplier-fulfillments", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT rf.fulfillment_id,
                    rf.request_id,
                    rf.quantity_supplied,
                    rf.fulfillment_status,
                    rf.fulfillment_date,
                    r.resource_name,
                    rc.name AS camp_name
             FROM request_fulfillment rf
             LEFT JOIN resource_request rr ON rf.request_id = rr.request_id
             LEFT JOIN resource r ON rr.resource_id = r.resource_id
             LEFT JOIN relief_camp rc ON rr.camp_id = rc.camp_id
             ORDER BY rf.fulfillment_date DESC
             LIMIT 10`
        );
        res.json({ success: true, deliveries: rows });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.get("/camp-dashboard", async (req, res) => {
    try {
        const [stockTotals] = await dbPromise.query(
            "SELECT IFNULL(SUM(quantity_available), 0) AS totalAvailable, IFNULL(SUM(minimum_threshold), 0) AS totalThreshold FROM inventory_stock"
        );
        const [totalRequests] = await dbPromise.query(
            "SELECT COUNT(*) AS totalCount FROM resource_request"
        );
        const [pendingRequests] = await dbPromise.query(
            "SELECT COUNT(*) AS pendingCount FROM resource_request WHERE status = 'PENDING'"
        );
        const [highPriority] = await dbPromise.query(
            "SELECT COUNT(*) AS highCount FROM resource_request WHERE priority_level IN ('HIGH', 'high') AND status = 'PENDING'"
        );
        const [pendingFulfillment] = await dbPromise.query(
            "SELECT COUNT(*) AS pendingFulfillmentCount FROM resource_request WHERE status <> 'COMPLETED'"
        );

        const totalAvailable = stockTotals[0].totalAvailable || 0;
        const totalThreshold = stockTotals[0].totalThreshold || 0;
        const localStockPercent = totalThreshold > 0 ? Math.min(100, Math.round((totalAvailable / totalThreshold) * 100)) : 100;

        res.json({
            success: true,
            localStockPercent,
            totalRequests: totalRequests[0].totalCount || 0,
            pendingRequests: pendingRequests[0].pendingCount || 0,
            highPriority: highPriority[0].highCount || 0,
            pendingFulfillment: pendingFulfillment[0].pendingFulfillmentCount || 0
        });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.get("/camp-shortages", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT s.quantity_available,
                    s.minimum_threshold,
                    r.resource_name
             FROM inventory_stock s
             LEFT JOIN resource r ON s.resource_id = r.resource_id
             ORDER BY CASE WHEN s.minimum_threshold = 0 THEN 0 ELSE s.quantity_available / s.minimum_threshold END ASC,
                      s.quantity_available ASC
             LIMIT 4`
        );
        res.json({ success: true, shortages: rows });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.get("/camp-requests", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT rr.request_id,
                    rr.quantity_required,
                    rr.priority_level,
                    rr.status,
                    rr.request_date,
                    rc.name AS camp_name,
                    r.resource_name
             FROM resource_request rr
             LEFT JOIN relief_camp rc ON rr.camp_id = rc.camp_id
             LEFT JOIN resource r ON rr.resource_id = r.resource_id
             ORDER BY rr.request_date DESC`
        );
        res.json({ success: true, requests: rows });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.post("/camp-update-request-status", async (req, res) => {
    const { requestId, status } = req.body;
    try {
        await dbPromise.query("UPDATE resource_request SET status = ? WHERE request_id = ?", [status, requestId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.get("/inventory-requests", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT rr.request_id,
                    rr.quantity_required,
                    rr.priority_level,
                    LOWER(rr.status) AS status,
                    rr.request_date,
                    rc.name AS camp_name,
                    rc.location AS camp_location,
                    r.resource_name
             FROM resource_request rr
             LEFT JOIN relief_camp rc ON rr.camp_id = rc.camp_id
             LEFT JOIN resource r ON rr.resource_id = r.resource_id
             WHERE rr.status = 'PENDING'
             ORDER BY rr.priority_level DESC, rr.request_date ASC`
        );
        res.json({ success: true, requests: rows });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.post("/update-request-status", async (req, res) => {
    const { requestId, status } = req.body;
    try {
        await dbPromise.query("UPDATE resource_request SET status = ? WHERE request_id = ?", [status, requestId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(err);
    }
});

app.get("/dashboard", async (req, res) => {
    try {
        const [requestRows] = await dbPromise.query("SELECT COUNT(*) AS totalRequests FROM resource_request");
        const [campRows] = await dbPromise.query("SELECT COUNT(*) AS totalCamps FROM relief_camp");
        const [inventoryRows] = await dbPromise.query("SELECT IFNULL(SUM(quantity_available), 0) AS totalInventory FROM inventory_stock");
        const [shortageRows] = await dbPromise.query("SELECT COUNT(*) AS shortageCount FROM inventory_stock WHERE quantity_available < minimum_threshold");

        res.json({
            totalRequests: requestRows[0].totalRequests || 0,
            totalCamps: campRows[0].totalCamps || 0,
            totalInventory: inventoryRows[0].totalInventory || 0,
            shortageCount: shortageRows[0].shortageCount || 0
        });
    } catch (err) {
        res.status(500).send(err);
    }
});

// ===== RESOURCE LIST (for form selections) =====
app.get("/resources-list", async (req, res) => {
    try {
        const [rows] = await dbPromise.query("SELECT resource_id, resource_name, unit FROM resource");
        res.json({ success: true, resources: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== CAMP DETAILS =====
app.get("/camp-details", async (req, res) => {
    const campId = parseInt(req.query.camp_id, 10) || 4;
    try {
        const [rows] = await dbPromise.query(
            `SELECT
                rc.name AS camp_name,
                rc.location,
                rc.capacity,
                aa.area_name,
                d.disaster_type
             FROM relief_camp rc
             LEFT JOIN affected_area aa ON rc.area_id = aa.area_id
             LEFT JOIN disaster d ON aa.disaster_id = d.disaster_id
             WHERE rc.camp_id = ?`,
            [campId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: "Camp not found" });
        }

        res.json(rows[0]);
    } catch (err) {
        res.status(500).json(err);
    }
});

// ===== CAMP STOCK =====
app.get("/camp-stock", async (req, res) => {
    const campId = parseInt(req.query.camp_id, 10) || 4;
    try {
        const [rows] = await dbPromise.query(
            `SELECT cs.stock_id,
                    r.resource_name,
                    cs.quantity_available AS quantity,
                    cs.resource_id
             FROM camp_stock cs
             LEFT JOIN resource r ON cs.resource_id = r.resource_id
             WHERE cs.camp_id = ?
             ORDER BY r.resource_name ASC`,
            [campId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json(err);
    }
});

// ===== CAMP DISPATCH HISTORY =====
app.get("/camp-dispatch-history", async (req, res) => {
    const campId = parseInt(req.query.camp_id, 10) || 4;
    try {
        const [rows] = await dbPromise.query(
            `SELECT dispatch_id,
                    stock_id,
                    resource_id,
                    resource_name,
                    quantity_dispatched,
                    dispatch_date
             FROM camp_dispatch_history
             WHERE camp_id = ?
             ORDER BY dispatch_date DESC, dispatch_id DESC
             LIMIT 20`,
            [campId]
        );

        res.json({ success: true, dispatches: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== CAMP FULFILLMENT HISTORY FROM INVENTORY DISPATCHES =====
app.get("/camp-fulfillment-history", async (req, res) => {
    const campId = parseInt(req.query.camp_id, 10) || 4;
    try {
        const [rows] = await dbPromise.query(
            `SELECT rf.fulfillment_id,
                    rf.request_id,
                    rf.quantity_supplied,
                    rf.fulfillment_status,
                    rf.fulfillment_date,
                    r.resource_name
             FROM request_fulfillment rf
             LEFT JOIN resource_request rr ON rf.request_id = rr.request_id
             LEFT JOIN resource r ON rr.resource_id = r.resource_id
             WHERE rr.camp_id = ?
             ORDER BY rf.fulfillment_date DESC, rf.fulfillment_id DESC`,
            [campId]
        );

        res.json({ success: true, deliveries: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== ADMIN TODAY ACTIVITY DASHBOARD =====
app.get("/admin/today-activity", async (req, res) => {
    try {
        const [todayResult, campRequestsResult, inventoryDispatchesResult, inventoryOrdersResult, supplierDeliveriesResult] = await Promise.all([
            dbPromise.query(`SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today`),
            dbPromise.query(
                `SELECT rr.request_id AS reference_id,
                        rr.request_date AS activity_date,
                        rc.name AS actor_name,
                        r.resource_name,
                        rr.quantity_required,
                        rr.priority_level,
                        rr.status
                 FROM resource_request rr
                 LEFT JOIN relief_camp rc ON rr.camp_id = rc.camp_id
                 LEFT JOIN resource r ON rr.resource_id = r.resource_id
                 WHERE rr.request_date = CURDATE()
                 ORDER BY rr.request_id DESC`
            ),
            dbPromise.query(
                `SELECT rf.fulfillment_id AS reference_id,
                        rf.fulfillment_date AS activity_date,
                        rc.name AS camp_name,
                        r.resource_name,
                        rr.quantity_required,
                        rf.quantity_supplied,
                        rf.fulfillment_status
                 FROM request_fulfillment rf
                 LEFT JOIN resource_request rr ON rf.request_id = rr.request_id
                 LEFT JOIN relief_camp rc ON rr.camp_id = rc.camp_id
                 LEFT JOIN resource r ON rr.resource_id = r.resource_id
                 WHERE rf.fulfillment_date = CURDATE()
                 ORDER BY rf.fulfillment_id DESC`
            ),
            dbPromise.query(
                `SELECT sp.supply_id AS reference_id,
                        sp.supply_date AS activity_date,
                        ci.name AS inventory_name,
                        sup.supplier_name,
                        r.resource_name,
                        sp.quantity_supplied,
                        sp.priority_level,
                        sp.status
                 FROM supply sp
                 LEFT JOIN central_inventory ci ON sp.inventory_id = ci.inventory_id
                 LEFT JOIN supplier sup ON sp.supplier_id = sup.supplier_id
                 LEFT JOIN resource r ON sp.resource_id = r.resource_id
                 WHERE sp.supply_date = CURDATE()
                 ORDER BY sp.supply_id DESC`
            ),
            dbPromise.query(
                `SELECT sp.supply_id AS reference_id,
                        sp.supply_date AS activity_date,
                        sup.supplier_name,
                        ci.name AS inventory_name,
                        r.resource_name,
                        sp.quantity_supplied,
                        sp.priority_level
                 FROM supply sp
                 LEFT JOIN supplier sup ON sp.supplier_id = sup.supplier_id
                 LEFT JOIN central_inventory ci ON sp.inventory_id = ci.inventory_id
                 LEFT JOIN resource r ON sp.resource_id = r.resource_id
                 WHERE sp.status = 'APPROVED' AND sp.supply_date = CURDATE()
                 ORDER BY sp.supply_id DESC`
            )
        ]);

        const campRequests = campRequestsResult[0];
        const inventoryDispatches = inventoryDispatchesResult[0];
        const inventoryOrders = inventoryOrdersResult[0];
        const supplierDeliveries = supplierDeliveriesResult[0];
        const today = todayResult[0][0].today;

        const campManagerActivities = campRequests.map((row) => ({
            referenceId: row.reference_id,
            referenceLabel: `REQ-${row.reference_id}`,
            actorName: row.actor_name || "Unknown Camp",
            activityDate: row.activity_date,
            action: "Raised request",
            detail: `${row.quantity_required} ${row.resource_name || "resource"} requested`,
            meta: `Priority ${row.priority_level || "MEDIUM"}`,
            status: row.status || "PENDING"
        }));

        const inventoryDispatchActivities = inventoryDispatches.map((row) => ({
            referenceId: row.reference_id,
            referenceLabel: `FUL-${row.reference_id}`,
            actorName: "Inventory Manager",
            activityDate: row.activity_date,
            action: "Dispatched resources",
            detail: `${row.quantity_supplied} ${row.resource_name || "resource"} sent to ${row.camp_name || "camp"}`,
            meta: `Against request for ${row.quantity_required || 0}`,
            status: row.fulfillment_status || "PARTIAL"
        }));

        const inventoryOrderActivities = inventoryOrders.map((row) => ({
            referenceId: row.reference_id,
            referenceLabel: `SUP-${row.reference_id}`,
            actorName: row.inventory_name || "Inventory",
            activityDate: row.activity_date,
            action: "Raised supplier order",
            detail: `${row.quantity_supplied} ${row.resource_name || "resource"} from ${row.supplier_name || "supplier"}`,
            meta: `Priority ${row.priority_level || "MEDIUM"}`,
            status: row.status || "PENDING"
        }));

        const inventoryManagerActivities = [...inventoryDispatchActivities, ...inventoryOrderActivities]
            .sort((a, b) => b.referenceId - a.referenceId);

        const supplierActivities = supplierDeliveries.map((row) => ({
            referenceId: row.reference_id,
            referenceLabel: `SUP-${row.reference_id}`,
            actorName: row.supplier_name || "Supplier",
            activityDate: row.activity_date,
            action: "Completed delivery",
            detail: `${row.quantity_supplied} ${row.resource_name || "resource"} delivered to ${row.inventory_name || "inventory"}`,
            meta: `Priority ${row.priority_level || "MEDIUM"}`,
            status: "APPROVED"
        }));

        const feed = [
            ...campManagerActivities.map((item) => ({ role: "Camp Manager", sortGroup: 3, ...item })),
            ...inventoryManagerActivities.map((item) => ({ role: "Inventory Manager", sortGroup: 2, ...item })),
            ...supplierActivities.map((item) => ({ role: "Supplier", sortGroup: 1, ...item }))
        ].sort((a, b) => {
            if (b.sortGroup !== a.sortGroup) {
                return b.sortGroup - a.sortGroup;
            }
            return b.referenceId - a.referenceId;
        });

        const totalRequestedUnits = campRequests.reduce((sum, row) => sum + Number(row.quantity_required || 0), 0);
        const totalDispatchedUnits = inventoryDispatches.reduce((sum, row) => sum + Number(row.quantity_supplied || 0), 0);
        const totalDeliveredUnits = supplierDeliveries.reduce((sum, row) => sum + Number(row.quantity_supplied || 0), 0);

        res.json({
            success: true,
            today,
            summary: {
                totalActivities: feed.length,
                campManagerActions: campManagerActivities.length,
                inventoryManagerActions: inventoryManagerActivities.length,
                supplierActions: supplierActivities.length,
                totalRequestedUnits,
                totalDispatchedUnits,
                totalDeliveredUnits
            },
            roleSections: {
                campManagers: campManagerActivities,
                inventoryManagers: inventoryManagerActivities,
                suppliers: supplierActivities
            },
            feed
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== GET ALL REQUESTS (for Admin & Inventory Manager) =====
app.get("/requests", async (req, res) => {
    const { camp_id } = req.query;
    try {
        let query = "SELECT rr.request_id, " +
                            "rr.quantity_required, " +
                            "rr.priority_level, " +
                            "rr.status, " +
                            "rr.request_date, " +
                            "rc.camp_id, " +
                            "rc.name AS camp_name, " +
                            "r.resource_id, " +
                            "r.resource_name, " +
                            "IFNULL((SELECT SUM(quantity_supplied) FROM request_fulfillment rf WHERE rf.request_id = rr.request_id), 0) AS quantity_supplied, " +
                            "GREATEST(0, rr.quantity_required - IFNULL((SELECT SUM(quantity_supplied) FROM request_fulfillment rf WHERE rf.request_id = rr.request_id), 0)) AS remaining_quantity " +
                            "FROM resource_request rr " +
                            "LEFT JOIN relief_camp rc ON rr.camp_id = rc.camp_id " +
                            "LEFT JOIN resource r ON rr.resource_id = r.resource_id";
        const params = [];

        if (camp_id) {
            query += " WHERE rr.camp_id = ?";
            params.push(camp_id);
        }

        query += " ORDER BY FIELD(rr.status, 'PENDING', 'PARTIAL', 'COMPLETED'), FIELD(rr.priority_level, 'HIGH', 'MEDIUM', 'LOW'), rr.request_date DESC, rr.request_id DESC";

        const [rows] = await dbPromise.query(query, params);
        res.json({ success: true, requests: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== GET REQUESTS FOR SPECIFIC CAMP (for Camp Manager) =====
app.get("/camp-requests/:campId", async (req, res) => {
    const { campId } = req.params;
    try {
        const [rows] = await dbPromise.query(
            `SELECT rr.request_id,
                    rr.quantity_required,
                    rr.priority_level,
                    rr.status,
                    rr.request_date,
                    r.resource_name
             FROM resource_request rr
             LEFT JOIN resource r ON rr.resource_id = r.resource_id
             WHERE rr.camp_id = ?
             ORDER BY rr.request_date DESC`,
            [campId]
        );
        res.json({ success: true, requests: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== GET CAMP REQUESTS READY FOR FULFILLMENT =====
app.get("/approved-requests", async (req, res) => {
    const campId = parseInt(req.query.camp_id, 10) || 4;
    try {
        const [rows] = await dbPromise.query(
            `SELECT rr.request_id,
                    rr.quantity_required,
                    rr.priority_level AS priority,
                    rr.status,
                    rr.request_date,
                    r.resource_name,
                    IFNULL((
                        SELECT SUM(rf.quantity_supplied)
                        FROM request_fulfillment rf
                        WHERE rf.request_id = rr.request_id
                    ), 0) AS quantity_supplied,
                    GREATEST(
                        0,
                        rr.quantity_required - IFNULL((
                            SELECT SUM(rf.quantity_supplied)
                            FROM request_fulfillment rf
                            WHERE rf.request_id = rr.request_id
                        ), 0)
                    ) AS remaining_quantity
             FROM resource_request rr
             LEFT JOIN resource r ON rr.resource_id = r.resource_id
             WHERE rr.camp_id = ?
             ORDER BY FIELD(rr.status, 'PENDING', 'PARTIAL', 'COMPLETED'), FIELD(rr.priority_level, 'HIGH', 'MEDIUM', 'LOW'), rr.request_date DESC, rr.request_id DESC`,
            [campId]
        );

        res.json({ success: true, requests: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== CREATE NEW REQUEST (Camp Manager) =====
app.post("/requests", async (req, res) => {
    const { campId, resourceId, quantityRequired, priorityLevel } = req.body;
    try {
        // Validate inputs
        if (!campId || !resourceId || !quantityRequired || !priorityLevel) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        const requestDate = new Date().toISOString().split('T')[0];
        
        const [result] = await dbPromise.query(
            `INSERT INTO resource_request (camp_id, resource_id, quantity_required, priority_level, status, request_date)
             VALUES (?, ?, ?, ?, 'PENDING', ?)`,
            [campId, resourceId, quantityRequired, priorityLevel, requestDate]
        );
        
        res.json({
            success: true,
            message: "Request created successfully",
            requestId: result.insertId
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});



// ===== APPROVE/REJECT REQUEST (Admin) =====
app.put("/requests/:id", async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    try {
        // Validate status
        if (!["PENDING", "PARTIAL", "COMPLETED"].includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status" });
        }

        const [result] = await dbPromise.query(
            "UPDATE resource_request SET status = ? WHERE request_id = ?",
            [status, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        res.json({ success: true, message: "Request updated successfully" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== GET INVENTORY (Inventory Manager) =====
app.get("/inventory", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT s.inv_stock_id,
                    s.quantity_available,
                    s.minimum_threshold,
                    ci.name AS inventory_name,
                    ci.location,
                    r.resource_id,
                    r.resource_name,
                    r.unit
             FROM inventory_stock s
             LEFT JOIN central_inventory ci ON s.inventory_id = ci.inventory_id
             LEFT JOIN resource r ON s.resource_id = r.resource_id
             ORDER BY ci.name, r.resource_name`
        );
        res.json({ success: true, inventory: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== DISPATCH RESOURCES (Inventory Manager) =====
app.post("/dispatch", authenticateToken,async (req, res) => {
    const { requestId, quantitySupplied } = req.body;
    const dispatchQuantity = parseInt(quantitySupplied, 10);

    if (req.user.role !== 'Inventory Manager' && req.user.role !== 'Admin') {
        return res.status(403).json({ success: false, message: "Only Inventory Managers can dispatch resources." });
    }
    
    try {
        if (!requestId || !dispatchQuantity || dispatchQuantity <= 0) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        // Get request details (Outside the transaction to validate first)
        const [requests] = await dbPromise.query(
            "SELECT * FROM resource_request WHERE request_id = ?",
            [requestId]
        );

        if (requests.length === 0) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        const request = requests[0];
        if (request.status === 'COMPLETED') {
            return res.status(400).json({ success: false, message: "Request is already completed" });
        }

        const [fulfillments] = await dbPromise.query(
            "SELECT IFNULL(SUM(quantity_supplied), 0) AS totalSupplied FROM request_fulfillment WHERE request_id = ?",
            [requestId]
        );
        const totalSuppliedSoFar = Number(fulfillments[0].totalSupplied || 0);
        const remainingRequired = Number(request.quantity_required) - totalSuppliedSoFar;

        if (dispatchQuantity > remainingRequired) {
            return res.status(400).json({
                success: false,
                message: "Quantity cannot be more than remaining request quantity. Remaining: " + remainingRequired
            });
        }

        // --- BEGIN SQL TRANSACTION ---
        await dbPromise.query("START TRANSACTION");

        try {
            // 1. Get inventory stock with a ROW LOCK (FOR UPDATE)
            // This prevents anyone else from editing this row while we are looking at it.
            const [stocks] = await dbPromise.query(
                `SELECT * FROM inventory_stock 
                 WHERE resource_id = ?
                 ORDER BY quantity_available DESC
                 LIMIT 1 FOR UPDATE`,
                [request.resource_id]
            );

            if (stocks.length === 0 || Number(stocks[0].quantity_available) < dispatchQuantity) {
                // If there isn't enough, we cancel the transaction before making changes.
                await dbPromise.query("ROLLBACK");
                return res.status(400).json({ 
                    success: false, 
                    message: "Insufficient inventory. Available: " + (stocks.length > 0 ? stocks[0].quantity_available : 0)
                });
            }

            const stock = stocks[0];
            const cumulativeSupplied = totalSuppliedSoFar + dispatchQuantity;

            // 2. Update central inventory
            const newQuantity = Number(stock.quantity_available) - dispatchQuantity;
            await dbPromise.query(
                "UPDATE inventory_stock SET quantity_available = ? WHERE inv_stock_id = ?",
                [newQuantity, stock.inv_stock_id]
            );

            // 3. Update camp stock
            const [campStocks] = await dbPromise.query(
                `SELECT * FROM camp_stock WHERE camp_id = ? AND resource_id = ? LIMIT 1`,
                [request.camp_id, request.resource_id]
            );

            if (campStocks.length > 0) {
                const campStock = campStocks[0];
                const updatedCampQuantity = Number(campStock.quantity_available) + dispatchQuantity;
                await dbPromise.query(
                    "UPDATE camp_stock SET quantity_available = ? WHERE stock_id = ?",
                    [updatedCampQuantity, campStock.stock_id]
                );
            } else {
                await dbPromise.query(
                    `INSERT INTO camp_stock (camp_id, resource_id, quantity_available)
                     VALUES (?, ?, ?)`,
                    [request.camp_id, request.resource_id, dispatchQuantity]
                );
            }

            // 4. Create fulfillment record
            const fulfillmentDate = new Date().toISOString().split('T')[0];
            const fulfillmentStatus = cumulativeSupplied >= request.quantity_required ? "COMPLETED" : "PARTIAL";
            
            const [result] = await dbPromise.query(
                `INSERT INTO request_fulfillment (request_id, quantity_supplied, fulfillment_date, fulfillment_status)
                 VALUES (?, ?, ?, ?)`,
                [requestId, dispatchQuantity, fulfillmentDate, fulfillmentStatus]
            );

            // 5. Update request status
            await dbPromise.query(
                "UPDATE resource_request SET status = ? WHERE request_id = ?",
                [fulfillmentStatus, requestId]
            );

            // --- ALL SUCCESSFUL: COMMIT THE TRANSACTION ---
            await dbPromise.query("COMMIT");

            res.json({
                success: true,
                message: "Dispatch recorded successfully with full transactional integrity.",
                fulfillmentId: result.insertId,
                cumulativeSupplied,
                remainingQuantity: Math.max(0, Number(request.quantity_required) - cumulativeSupplied)
            });

        } catch (transactionError) {
            // --- ERROR OCCURRED: ROLLBACK EVERYTHING ---
            await dbPromise.query("ROLLBACK");
            console.error("Transaction Error, Rolling back:", transactionError.message);
            res.status(500).json({ success: false, message: "Database transaction failed. Changes reverted.", error: transactionError.message });
        }

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== GET SUPPLY HISTORY (Supplier) =====
app.get("/supply", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT sp.supply_id,
                    sp.supply_date,
                    sp.quantity_supplied,
                    sp.priority_level,
                    r.resource_name,
                    ci.name AS inventory_name,
                    sup.supplier_name,
                    CASE
                        WHEN sp.supply_date > CURDATE() THEN 'SCHEDULED'
                        WHEN sp.supply_date = CURDATE() THEN 'SCHEDULED TODAY'
                        ELSE 'DELIVERED'
                    END AS order_status
             FROM supply sp
             LEFT JOIN resource r ON sp.resource_id = r.resource_id
             LEFT JOIN central_inventory ci ON sp.inventory_id = ci.inventory_id
             LEFT JOIN supplier sup ON sp.supplier_id = sup.supplier_id
             ORDER BY sp.supply_date DESC`
        );
        res.json({ success: true, supplies: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/supplier-orders", async (req, res) => {
    const supplierId = parseInt(req.query.supplier_id, 10);
    try {
        let query = `SELECT sp.supply_id,
                            sp.supply_date,
                            sp.quantity_supplied,
                            sp.priority_level,
                            r.resource_name,
                            ci.name AS inventory_name,
                            sup.supplier_name,
                            'PENDING' AS order_status
                     FROM supply sp
                     LEFT JOIN resource r ON sp.resource_id = r.resource_id
                     LEFT JOIN central_inventory ci ON sp.inventory_id = ci.inventory_id
                     LEFT JOIN supplier sup ON sp.supplier_id = sup.supplier_id
                     WHERE sp.status = 'PENDING'`;
        const params = [];

        if (supplierId) {
            query += " AND sp.supplier_id = ?";
            params.push(supplierId);
        }

        query += " ORDER BY FIELD(sp.priority_level, 'HIGH', 'MEDIUM', 'LOW'), sp.supply_date ASC, sp.supply_id ASC";

        const [rows] = await dbPromise.query(query, params);
        res.json({ success: true, orders: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/supplier-deliveries", async (req, res) => {
    const supplierId = parseInt(req.query.supplier_id, 10);
    try {
        let query = `SELECT sp.supply_id,
                            sp.supply_date,
                            sp.quantity_supplied,
                            sp.priority_level,
                            r.resource_name,
                            ci.name AS inventory_name,
                            sup.supplier_name,
                            'APPROVED' AS order_status
                     FROM supply sp
                     LEFT JOIN resource r ON sp.resource_id = r.resource_id
                     LEFT JOIN central_inventory ci ON sp.inventory_id = ci.inventory_id
                     LEFT JOIN supplier sup ON sp.supplier_id = sup.supplier_id
                     WHERE sp.status = 'APPROVED'`;
        const params = [];

        if (supplierId) {
            query += " AND sp.supplier_id = ?";
            params.push(supplierId);
        }

        query += " ORDER BY sp.supply_date DESC";

        const [rows] = await dbPromise.query(query, params);
        res.json({ success: true, deliveries: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== ADD SUPPLY (Supplier) =====
app.post("/supply", async (req, res) => {
    const { supplierId, inventoryId, resourceId, quantitySupplied, supplyDate, priorityLevel } = req.body;
    const priority = ["HIGH", "MEDIUM", "LOW"].includes(priorityLevel) ? priorityLevel : "MEDIUM";
    
    try {
        if (!supplierId || !inventoryId || !resourceId || !quantitySupplied) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        // Insert supply record as a pending supplier order.
        const [result] = await dbPromise.query(
            `INSERT INTO supply (supplier_id, inventory_id, resource_id, quantity_supplied, supply_date, status, priority_level)
             VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
            [supplierId, inventoryId, resourceId, quantitySupplied, supplyDate || new Date().toISOString().split('T')[0], priority]
        );

        res.json({
            success: true,
            message: "Supplier order created successfully",
            supplyId: result.insertId
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/supply/:id/approve", async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await dbPromise.query(
            "SELECT * FROM supply WHERE supply_id = ?",
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Supplier order not found" });
        }

        const order = rows[0];
        if (order.status !== 'PENDING') {
            return res.status(400).json({ success: false, message: "Order is already approved or not pending" });
        }

        const [stocks] = await dbPromise.query(
            `SELECT * FROM inventory_stock WHERE inventory_id = ? AND resource_id = ?`,
            [order.inventory_id, order.resource_id]
        );

        if (stocks.length > 0) {
            const stock = stocks[0];
            const newQuantity = stock.quantity_available + order.quantity_supplied;
            await dbPromise.query(
                "UPDATE inventory_stock SET quantity_available = ? WHERE inv_stock_id = ?",
                [newQuantity, stock.inv_stock_id]
            );
        } else {
            await dbPromise.query(
                `INSERT INTO inventory_stock (inventory_id, resource_id, quantity_available, minimum_threshold)
                 VALUES (?, ?, ?, 0)`,
                [order.inventory_id, order.resource_id, order.quantity_supplied]
            );
        }

        await dbPromise.query(
            "UPDATE supply SET status = 'APPROVED' WHERE supply_id = ?",
            [id]
        );

        res.json({ success: true, message: "Supplier order approved and inventory updated" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== GET CAMPS (for dropdown in forms) =====
app.get("/camps", async (req, res) => {
    try {
        const [rows] = await dbPromise.query("SELECT camp_id, name FROM relief_camp");
        res.json({ success: true, camps: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== GET SUPPLIERS (for dropdown in forms) =====
app.get("/suppliers", async (req, res) => {
    try {
        const [rows] = await dbPromise.query("SELECT supplier_id, supplier_name FROM supplier");
        res.json({ success: true, suppliers: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== GET INVENTORIES (for dropdown in forms) =====
app.get("/inventories", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT inventory_id,
                    name,
                    location,
                    total_capacity,
                    created_at
             FROM central_inventory`
        );
        res.json({ success: true, inventories: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Keep old endpoints for compatibility
app.get("/resources", async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            `SELECT r.resource_id,
                    r.resource_name,
                    r.unit,
                    IFNULL(SUM(s.quantity_available), 0) AS total_available
             FROM resource r
             LEFT JOIN inventory_stock s ON r.resource_id = s.resource_id
             GROUP BY r.resource_id, r.resource_name, r.unit`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).send(err);
    }
});

// ===== DISPATCH FROM CAMP STOCK (Camp Manager) =====
app.post("/dispatch-camp-stock", async (req, res) => {
    const { stockId, quantityDispatched, campId } = req.body;
    const activeCampId = parseInt(campId, 10) || 4;
    
    try {
        const parsedStockId = parseInt(stockId, 10);
        const parsedQuantity = parseInt(quantityDispatched, 10);

        if (!parsedStockId || !parsedQuantity || parsedQuantity <= 0) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        // Get camp stock details
        const [stocks] = await dbPromise.query(
            `SELECT cs.stock_id, cs.quantity_available, cs.resource_id, r.resource_name
             FROM camp_stock cs
             LEFT JOIN resource r ON cs.resource_id = r.resource_id
             WHERE cs.stock_id = ? AND cs.camp_id = ?`,
            [parsedStockId, activeCampId]
        );

        if (stocks.length === 0) {
            return res.status(404).json({ success: false, message: "Stock not found" });
        }

        const stock = stocks[0];

        // Check if sufficient quantity available
        if (Number(stock.quantity_available) < parsedQuantity) {
            return res.status(400).json({ 
                success: false, 
                message: "Insufficient stock. Available: " + stock.quantity_available 
            });
        }

        // Reduce camp stock
        const newQuantity = Number(stock.quantity_available) - parsedQuantity;
        await dbPromise.query(
            "UPDATE camp_stock SET quantity_available = ? WHERE stock_id = ?",
            [newQuantity, parsedStockId]
        );

        // Create camp dispatch history record
        const fulfillmentDate = new Date().toISOString().split('T')[0];
        
        const [result] = await dbPromise.query(
            `INSERT INTO camp_dispatch_history
                (camp_id, stock_id, resource_id, resource_name, quantity_dispatched, dispatch_date)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [activeCampId, parsedStockId, stock.resource_id, stock.resource_name, parsedQuantity, fulfillmentDate]
        );

        res.json({
            success: true,
            message: "Resources dispatched successfully",
            dispatchId: result.insertId,
            resourceName: stock.resource_name,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});


