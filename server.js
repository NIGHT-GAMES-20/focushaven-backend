import express from "express";
import cors from "cors";
import login from "./api/login.router.js"
import signin from "./api/signin.router.js"
import notes from "./api/notes.router.js";
import notesUpdate from "./api/noteUpdate.router.js";
import noteDownload from "./api/noteDownload.router.js";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

dotenv.config();

export default async function CreateServer(client,drive){

    const app = express();

    app.use(cookieParser());
    app.use(cors({ origin: [process.env.FRONTEND_URL, process.env.BACKEND_URL], // ✅ Allow requests from the frontend
      credentials: true,                // ✅ Allow credentials (cookies)
    }));
      
    app.use(express.json());

    app.use("/api/v1/login", await login(client))
    app.use("/api/v1/notes", notes(client,drive))
    app.use("/api/v1/notes/update", notesUpdate(client,drive))
    app.use("/api/v1/downloads/notes/download", await noteDownload(client,drive))
    app.use("/api/v1/signin", signin)
    app.use("/api/v1/uptime-keeper", (req, res) =>  res.status(200).json({ message: "Uptime keeper is working!" }));
    app.use("/api/v1/test", (req, res) => res.status(402).json({"Test":"Testing"}));
    app.use("*name", (req, res) => res.status(404).json({"error":"Not Found"}));

    return app
}