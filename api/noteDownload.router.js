import { Router } from 'express'
import dotenv from 'dotenv'
dotenv.config()

const router = Router()

export default async function noteDownload(client, drive) {
    router.get('/:fileName', async (req, res) => {
        const fileName = req.params.fileName
        
        const db = client.db('focushaven')
        const notesCollection = db.collection('notes')


        const file = await notesCollection.findOne({ topic: fileName });
        const fileId = file.url; // Assuming the file ID is stored in the 'url' field

        try {
            const driveResponse = await drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'stream' }
            )
        
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}.${file.extension}"`)
            res.setHeader('Content-Type', 'application/octet-stream')
        
            driveResponse.data
                .on('end', () => {})
                .on('error', (err) => {
                res.status(500).send(`Error downloading file.: ${err}`)
                })
                .pipe(res)
        } catch (err) {
        res.status(500).json({ message: 'Failed to download file', error: err.message })
        }
    })
    return router;
}