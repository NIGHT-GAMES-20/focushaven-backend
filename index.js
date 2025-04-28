import app from "./server.js";
import mongodb from "mongodb";
import dotenv from "dotenv";

dotenv.config();
const MongoClient = mongodb.MongoClient;

const MONGODB_USER = process.env['MONGODB_USER'];
const MONGODB_PASSWORD = process.env['MONGODB_PASSWORD'];
const MONGODB_URI = process.env['MONGODB_URI'];
const BACKEND_URL = process.env['BACKEND_URL'];

const uri = `mongodb+srv://${MONGODB_USER}:${MONGODB_PASSWORD}${MONGODB_URI}`;

const PORT = 8000;

(async () => {
  try {
    const client = await MongoClient.connect(uri, {
      maxPoolSize: 50,
      wtimeoutMS: 2500,
    });

    const server = await app(client);
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (e) {
    console.error("Connection error:", e);
  }
})();

setInterval(() => {
  console.log('14 minutes passed, running task.')

  // Perform your task here
  fetch(`${BACKEND_URL}/api/v1/uptime-keeper`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ important: 'data' })
  })
    .then(res => res.json())
    .then(data => console.log('Task complete:', data.message))
    .catch(err => console.error('Error:', err))

}, 14 * 60 * 1000) // 14 mins in ms

