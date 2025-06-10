import express, { text } from 'express';
import fetch from 'node-fetch';

export default async function questions(client,AstraDB) {
    const router = express.Router();
    const questionsCollection = AstraDB.collection("questions");

    const pageSize  = 10; // Number of items per page

    router.get("/questions", async (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * pageSize;

        try {
            const questions = await questionsCollection.find({},{ projection: { text: 1 }}).sort({ createdAt: -1 }).skip(skip).limit(pageSize).toArray();
            res.json({ success: true, questions: questions});
        } catch (err) {
            res.status(500).json({ message: 'Internal server error' , error: err.message });
        }
    });

    router.get("/questions/pages", async (req, res) => {
        try {
            const count = await questionsCollection.countDocuments({},Number.MAX_SAFE_INTEGER);
            const pageCount = Math.ceil(count / pageSize); // Assuming 10 items per page
            res.json({ success: true, pages: pageCount });
        } catch (err) {
            res.status(500).json({ message: 'Internal server error' , error: err.message });
        }
    });

    router.get("/search/questions", async (req, res) => {
        const searchText = req.body.search;
        if (!searchText) {
            return res.status(400).json({ message: 'Search text is required' });
        }

        const searchVector = await inferenceAPI(searchText);
        if( Object.keys(searchVector).length !== 1024) {
            return res.status(searchVector.status || 500).json({ message: searchVector.error || 'Error processing search vector' });
        }

        try {
            const results = await questionsCollection.find({},{ projection: { question: 1, _id: 0 }, sort: { $vector: searchVector }}).limit(pageSize).toArray();
            res.json({ success: true, results: results });
        } catch (err) {
            res.status(500).json({ message: 'Internal server error', error: err.message });
        }
    });
    return router;
}

async function inferenceAPI(input) {
    const API_URL = "https://router.huggingface.co/hf-inference/models/intfloat/multilingual-e5-large/pipeline/feature-extraction";
    const HEADERS = {
        "Authorization": `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
        "Content-Type": "application/json"
    };

    const body = JSON.stringify({ inputs: input });

    try {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: HEADERS,
            body
        });

        if (!res.ok) {
            return {error: `API Error: ${res.statusText}`, status: res.status};;
        }

        const text = await res.text();
        const json = JSON.parse(text);
        return json;
    } catch (err) {
        return {error: err};
    }
}
