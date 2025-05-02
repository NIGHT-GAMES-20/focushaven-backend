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
  console.log(files)
  const existingFilesNotesCursor = await notesCollection.find({}, { projection: { topic: 1 } }).toArray();
  const existingFileTopics = existingFilesNotesCursor.map(f => f.topic); 

  for (const file of files) {
    
  
      const parts = file.name.split(".");

      const extension = parts[parts.length - 1].trim();       // last part (e.g. pdf)
      const subject = parts[parts.length - 2].trim();         // second last part (e.g. Chemistry)
      const className = parts[parts.length - 3].trim();       // third last part (e.g. 11)
      const topic = parts.slice(0, -3).join(".").trim();      // everything before
      
      if(!existingFileTopics.includes(topic)){
        await notesCollection.insertOne({
          class: className,
          topic: topic,
          sub : subject,
          url :file.id,
          extension: extension,
      });
    }
    
  }
}

export default (client,drive) => {

  router.post('/', async (req, res) => { 
    const authToken = req.cookies.authToken;
    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication Failed"
      });
    }
    
    try{
      const decoded = jwt.verify(authToken, process.env['SECRET_KEY']);
      const UserDB = client.db("username-pass");
      const userCollection = UserDB.collection("usernamePasswords");
      const user = await userCollection.findOne({username: decoded.username});
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