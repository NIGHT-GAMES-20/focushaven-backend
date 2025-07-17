import { Router } from 'express'
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const router = Router()

async function listFilesInFolder(drive) {
  try {
    const res = await drive.files.list({
      q: `'1KtGWe7oKrpwdUo8RVf_3607XAHqaZBjq' in parents and trashed = false`,
      fields: 'files(id, name)',
    });

    const files = res.data.files;
    if (!files.length) {
      console.log('No files found.');
      return [];
    }

    // Return array of { name, id }
    return files.map(file => ({
      name: file.name,
      id: file.id,
    }));
  } catch (err) {
    console.error('Error listing files:', err);
    return [];
  }
}

async function getNewTopics(client, drive) {
  const notesCollection = client.collection('notes');
  const files = await listFilesInFolder(drive);
  const existingFilesNotesCursor = await notesCollection.find({}, { projection: { topic: 1 } }).toArray();
  const existingFileTopics = existingFilesNotesCursor.map(f => f.topic);

  const newTopics = [];
  const driveFilesTopics = [];

  for (const file of files) {
    const parts = file.name.split(".");
    const topic = parts.slice(0, -3).join(".").trim();
    driveFilesTopics.push(topic)

    if (!existingFileTopics.includes(topic)) {
      newTopics.push({
        class: parts[parts.length - 3].trim(),
        topic,
        sub: parts[parts.length - 2].trim(),
        url: file.id,
        extension: parts[parts.length - 1].trim()
      });
    }
  }

  return { newTopics, existingFileTopics, driveFilesTopics }; // return both for update use
}


async function updateDBWithNewTopics(client, drive, reqFileTopic) {
  const notesCollection = client.collection('notes');
  const { newTopics, existingFileTopics, driveFilesTopics } = await getNewTopics(client, drive);

  const insertedTopics = [];

  if (!reqFileTopic) {
    // Full sync: Insert all new topics

    const { newTopicsA , existingFileTopics: existingFileTopicsA , driveFilesTopics: driveFilesTopicsA } = await getNewTopics(client, drive);
    // Get list of topic names from newTopics

    // Remove any topics from DB that were in existingFileTopics but are now gone from Drive
    for (const topic of existingFileTopicsA) {
      if (!driveFilesTopicsA.includes(topic)) {
        await notesCollection.deleteOne({ topic });
      }
    }

    for (const topicObj of newTopics) {
      await notesCollection.insertOne(topicObj);
      insertedTopics.push(topicObj.topic);
    }

  } else {
    // Partial update: Only update the one matching topic
    const topicObj = newTopics.find(t => t.topic === reqFileTopic);

    if (topicObj) {
      const existing = await notesCollection.findOne({ topic: topicObj.topic });
      if (existing) {
        await notesCollection.updateOne({ topic: topicObj.topic }, { $set: topicObj });
      } else {
        await notesCollection.insertOne(topicObj);
      }

      insertedTopics.push(topicObj.topic);
    } else {
      return `Requested topic not found in Drive.`;
    }
  }
  return insertedTopics
}



export default (client,drive) => {

  router.post('/', async (req, res) => { 
    const authToken = req.cookies.authToken;
    const reqFileTopic = req.query.file;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    
    try{
      const decoded = jwt.verify(authToken, process.env['SECRET_KEY']);
      const userCollection = client.collection("username_passwords");
      const user = await userCollection.findOne({username: decoded.username});
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "User Not Found"
        });
      }

      if(user.admin === true){
        const updateDBRes = await updateDBWithNewTopics(client,drive,reqFileTopic);
        if(updateDBRes !== `Requested topic not found in Drive.`)
          return res.status(200).json({
            success: true,
            message: "Database Updated"
          });
        else{
          return res.status(404).json({
            success: false,
            message: "Database Not Updated",
            error: "Requested topic not found in Drive."
          });
        }
      } else{
        return res.status(401).json({
          success: false,
          message: "Authentication Failed"
        });
      }
    }catch(err){
      return res.status(401).json({
        success: false,
        error: `${err}`
      });
    }
    
  });

  router.post('/listNewFiles', async (req, res) => { 
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    try{
      const decoded = jwt.verify(authToken, process.env['SECRET_KEY']);
      const userCollection = client.collection("username_passwords");
      const user = await userCollection.findOne({username: decoded.username});
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "User Not Found"
        });
      }

      if(user.admin === true){
        const files = await getNewTopics(client,drive);
        return res.status(200).json({
          success: true,
          newTopics: files.newTopics,
          existingFileTopics: files.existingFileTopics,
        });
      } else{
        return res.status(401).json({
          success: false,
          message: "Authentication Failed"
        });
      }
    }catch(err){
      return res.status(401).json({
        success: false,
        error: `${err}`
      });
    }
  });
  return router;
}