import { Router } from 'express'

const router = Router()

export default (client) => {
  const db = client.db('focushaven')
  const notesCollection = db.collection('notes')

  // Fetch topics for a class
  router.get('/:classId', async (req, res) => {
    const { classId } = req.params

    try {
      const notesCursor = await notesCollection.find({ class: Number(classId) })
      const notesArray = await notesCursor.toArray()

      const topics = notesArray.map(note => note.topic)

      res.json({ topics }) // only sending topic names
    } catch (error) {
      console.error('Error fetching topics:', error)
      res.status(500).json({ message: 'Server Error' })
    }
  })

  return router
}
