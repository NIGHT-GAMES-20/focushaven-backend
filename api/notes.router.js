import { Router } from 'express'

const router = Router()

export default (client) => {
  const db = client.db('focushaven')
  const notesCollection = db.collection('notes')

  // Fetch topics for a class
  router.get('/:classId/:subCode', async (req, res) => {
    const { classId, subCode } = req.params; // Destructure both classId and subCode from req.params
    try {
      const notesArray = await notesCollection.find({
        class: classId, // Convert classId to a number
        sub: subCode,        // Use subCode directly from the request parameters
      }).toArray();
      
      const topics = notesArray.map(note => note.topic); // Log the topics array
  
      res.json({ topics }); // Send back the array of topics
    } catch (error) {
      console.error('Error fetching topics:', error);
      res.status(500).json({ message: 'Server Error' });
    }
  });  

  return router
}
