import app from "./server.js";
import dotenv from "dotenv";
import { google } from 'googleapis';
import { DataAPIClient } from "@datastax/astra-db-ts";


dotenv.config();
const BACKEND_URL = process.env['BACKEND_URL'];
const serviceAccountKeyPath = './serviceAccountKey.json';

const PORT = 8000;


(async () => {
  try {

    const auth = new google.auth.GoogleAuth({
      keyFile: serviceAccountKeyPath,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const AstraClient = new DataAPIClient(process.env['ASTRA_DB_CLIENT_TOKEN']);
    const AstraDB = AstraClient.db(process.env['ASTRA_DB_URI']);

    setInterval(() => {
      AstraDB.collection("questions").countDocuments({},Number.MAX_SAFE_INTEGER);
    }, 47 * 60 * 60 * 1000);
  
    const server = await app(AstraDB, drive);
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (e) {
    console.error("Connection error:", e);
  }
})();

setInterval(() => {

  // Perform your task here
  fetch(`${BACKEND_URL}/api/v1/uptime-keeper`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ important: 'data' })
  })
    .then(res => res.json())
    .catch(err => console.error('Error:', err))

}, 14 * 60 * 1000) // 14 mins in ms

