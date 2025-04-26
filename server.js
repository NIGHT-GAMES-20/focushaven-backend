import express from "express";
import cors from "cors";
import login from "./api/login.router.js"
import signin from "./api/signin.router.js"
import cookieParser from "cookie-parser";

export default async function CreateServer(client){

    const app = express();

    app.use(cookieParser());
    app.use(cors({
        origin: "https://focushaven.vercel.app",  // ✅ Set frontend URL explicitly
        credentials: true,                // ✅ Allow credentials (cookies)
    }));
    app.use(express.json());

    app.use("/api/v1/login", await login(client))
    app.use("/api/v1/signin", signin)
    app.use("/api/v1/test", (req, res) => res.status(404).json({"Test":"Testing"}));
    app.use("*name", (req, res) => res.status(404).json({"error":"Not Found"}));

    return app
}