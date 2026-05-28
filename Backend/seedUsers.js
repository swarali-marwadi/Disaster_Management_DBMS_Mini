const mysql = require("mysql2");
const bcrypt = require("bcrypt");
require("dotenv").config(); // Reads your new .env vault!

// Create DB connection
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

const dbPromise = db.promise();

async function createDefaultUsers() {
    try {
        // The plain text password you will type on the login screen
        const plainTextPassword = "123"; 
        
        // Bcrypt hashes it with a "salt" of 10 rounds
        const hashedPassword = await bcrypt.hash(plainTextPassword, 10);

        // List of users based on your project's HTML files
        const users = [
            { email: 'admin@sys.com', role: 'Admin' },
            { email: 'inventory@sys.com', role: 'Inventory Manager' },
            { email: 'camp@sys.com', role: 'Camp Manager' },
            { email: 'supplier@sys.com', role: 'Supplier' }
        ];

        console.log("Seeding database with default users...");

        for (const user of users) {
            // Check if user already exists to prevent duplicate errors
            const [existingUser] = await dbPromise.query("SELECT * FROM users WHERE email = ?", [user.email]);
            
            if (existingUser.length === 0) {
                await dbPromise.query(
                    "INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)",
                    [user.email, hashedPassword, user.role]
                );
                console.log(`Created ${user.role}: ${user.email}`);
            } else {
                console.log(`User ${user.email} already exists. Skipping.`);
            }
        }

        console.log("\n🎉 All default users are ready! Password for all is: 123");
        process.exit(); // Closes the script

    } catch (err) {
        console.error("❌ Error creating users:", err);
        process.exit(1);
    }
}

createDefaultUsers();