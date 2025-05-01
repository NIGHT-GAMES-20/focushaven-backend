import { Router } from 'express'
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const router = Router()

export async function listFilesInFolder(drive) {
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


export async function updateDB(client,drive){

  const db = client.db('focushaven')
  const notesCollection = db.collection('notes')
  const files = await listFilesInFolder(drive);
  const existingFilesNotesCursor = await notesCollection.find({}, { projection: { topic: 1 } }).toArray();
  const existingFileTopics = existingFilesNotesCursor.map(f => f.topic); 

  for (const file of files) {
    if (!existingFileTopics.includes(file.name)) {
  
      const parts = file.name.split(".");
    
      const topic = parts.slice(0, -2).join(".").trim(); // everything before the last 2 dots
      const className = parts[parts.length - 2].trim();  // second last part
      const subject = parts[parts.length - 1].trim();    // last part
    
      await db.collection('files').insertOne({
        class: className,
        topic: topic,
        sub : subject,
        url :file.id,
      });
    }
  }

}

export default (client,drive) => {

  router.post('/', async (req, res) => { 
    const { authToken } = req.body; 
    
    try{
      const decoded = jwt.verify(authToken, process.env['SECRET_KEY']);
      username = decoded.username;
      const UserDB = client.db("username-pass");
      const userCollection = UserDB.collection("usernamePasswords");
      const user = await userCollection.findOne({username: username});
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "User Not Found"
        });
      }

      if(user.admin === true){
        await updateDB(client,drive);
        return res.status(200).json({
          success: true,
          message: "Database Updated"
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