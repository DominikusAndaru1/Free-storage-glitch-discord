const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const { token, channelId } = require('./config.json');
const axios = require('axios');

const app = express();
const port = 8080;

// Ensure the uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Initialize SQLite database (persistent)
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

// Create files table if not exists
db.serialize(() => {
    db.run('CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, fileName TEXT, fileType TEXT, totalChunks INTEGER, fileSize INTEGER, messageIds TEXT)');
});

// Fixed encryption key and IV for testing (in production, use a secure method)
const encryptionKey = crypto.createHash('sha256').update(String('fixed_key')).digest('base64').substr(0, 32);
const iv = Buffer.alloc(16, 0); // Initialization vector

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Discord bot setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', () => {
    console.log('Discord bot is ready!');
});

client.login(token);

// Upload chunk to Discord
async function uploadChunkToDiscord(chunkPath, fileName, currentChunk, totalChunks) {
    const attachment = new AttachmentBuilder(chunkPath); // Create the attachment correctly
    const channel = await client.channels.fetch(channelId);
    const message = await channel.send({ content: `Chunk ${currentChunk} of ${totalChunks} for ${fileName}`, files: [attachment] });
    fs.unlinkSync(chunkPath); // Delete the chunk file from the local filesystem
    return message.id;
}

// Endpoint to handle bulk file upload
app.post('/bulkUpload', upload.array('files'), async (req, res) => {
    const files = req.files;
    const chunkSize = 24 * 1024 * 1024; // 24MB (adjust as necessary)
    const bulkMessageIds = [];

    for (const file of files) {
        const totalChunks = Math.ceil(file.size / chunkSize);
        const fileName = file.originalname; // Automatically use original file name
        const fileType = file.mimetype; // Automatically detect file type
        const fileSize = file.size;

        const readStream = fs.createReadStream(file.path, { highWaterMark: chunkSize });
        let currentChunk = 0;
        const messageIds = [];

        for await (const chunk of readStream) {
            // Encrypt chunk
            const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
            let encryptedChunk = cipher.update(chunk);
            encryptedChunk = Buffer.concat([encryptedChunk, cipher.final()]);

            const chunkPath = path.join(uploadsDir, `${fileName}_chunk_${currentChunk + 1}.txt`);
            console.log(`Writing chunk to ${chunkPath}`);
            fs.writeFileSync(chunkPath, encryptedChunk);
            currentChunk++;

            try {
                const messageId = await uploadChunkToDiscord(chunkPath, fileName, currentChunk, totalChunks);
                messageIds.push(messageId);
            } catch (err) {
                console.error('Error uploading chunk to Discord:', err);
                res.status(500).send('Error uploading file.');
                return;
            }

            if (messageIds.length === totalChunks) {
                db.run('INSERT INTO files (fileName, fileType, totalChunks, fileSize, messageIds) VALUES (?, ?, ?, ?, ?)',
                    [fileName, fileType, totalChunks, fileSize, JSON.stringify(messageIds)], function (err) {
                        if (err) {
                            console.error('Error saving file information to database:', err);
                            res.status(500).send('Error saving file information.');
                            return;
                        }
                        const metadata = {
                            fileName: fileName,
                            fileType: fileType,
                            totalChunks: totalChunks,
                            fileSize: fileSize
                        };
                        fs.writeFileSync(path.join(uploadsDir, `${fileName}_metadata.json`), JSON.stringify(metadata));

                        // Clean up: delete the uploaded file from temp folder
                        fs.unlinkSync(file.path);

                        bulkMessageIds.push({ fileName: fileName, messageIds: messageIds });
                        if (bulkMessageIds.length === files.length) {
                            res.status(200).json({ message: 'Bulk upload completed successfully.', bulkMessageIds: bulkMessageIds });
                        }
                    });
            }
        }
    }
});
// Endpoint to handle file upload and splitting
app.post('/upload', upload.single('file'), async (req, res) => {
    const file = req.file;
    const chunkSize = 24 * 1024 * 1024; // 24MB
    const totalChunks = Math.ceil(file.size / chunkSize);
    const fileName = file.originalname; // Automatically use original file name
    const fileType = file.mimetype; // Automatically detect file type
    const fileSize = file.size;

    const readStream = fs.createReadStream(file.path, { highWaterMark: chunkSize });
    let currentChunk = 0;
    const messageIds = [];

    for await (const chunk of readStream) {
        // Encrypt chunk
        const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
        let encryptedChunk = cipher.update(chunk);
        encryptedChunk = Buffer.concat([encryptedChunk, cipher.final()]);

        const chunkPath = path.join(uploadsDir, `${fileName}_chunk_${currentChunk + 1}.txt`);
        console.log(`Writing chunk to ${chunkPath}`);
        fs.writeFileSync(chunkPath, encryptedChunk);
        currentChunk++;

        try {
            const messageId = await uploadChunkToDiscord(chunkPath, fileName, currentChunk, totalChunks);
            messageIds.push(messageId);
        } catch (err) {
            console.error('Error uploading chunk to Discord:', err);
            res.status(500).send('Error uploading file.');
            return;
        }

        if (messageIds.length === totalChunks) {
            db.run('INSERT INTO files (fileName, fileType, totalChunks, fileSize, messageIds) VALUES (?, ?, ?, ?, ?)', 
            [fileName, fileType, totalChunks, fileSize, JSON.stringify(messageIds)], function(err) {
                if (err) {
                    console.error('Error saving file information to database:', err);
                    res.status(500).send('Error saving file information.');
                    return;
                }
                const metadata = {
                    fileName: fileName,
                    fileType: fileType,
                    totalChunks: totalChunks,
                    fileSize: fileSize
                };
                fs.writeFileSync(path.join(uploadsDir, `${fileName}_metadata.json`), JSON.stringify(metadata));

                // Clean up: delete the uploaded file from temp folder
                fs.unlinkSync(file.path);

                res.status(200).send('File uploaded successfully.');
            });
        }
    }

    readStream.on('error', (err) => {
        console.error('Error reading the file:', err);
        res.status(500).send('Error reading the file.');
    });
});

// Endpoint to list all uploaded files
app.get('/files', (req, res) => {
    db.all('SELECT * FROM files', (err, rows) => {
        if (err) {
            console.error('Error retrieving files from database:', err);
            res.status(500).send('Error retrieving files.');
            return;
        }
        res.json(rows);
    });
});

// Endpoint to download the original file with streaming
app.get('/download/:id', async (req, res) => {
    const fileId = req.params.id;

    db.get('SELECT * FROM files WHERE id = ?', [fileId], async (err, row) => {
        if (err) {
            console.error('Error retrieving file information from database:', err);
            res.status(500).send('Error retrieving file information.');
            return;
        }

        if (!row) {
            res.status(404).send('File not found.');
            return;
        }

        const fileName = row.fileName;
        const fileType = row.fileType;
        const totalChunks = row.totalChunks;
        const messageIds = JSON.parse(row.messageIds);

        const decryptedChunks = [];

        for (let i = 0; i < totalChunks; i++) {
            const messageId = messageIds[i];
            const message = await client.channels.cache.get(channelId).messages.fetch(messageId);
            const attachment = message.attachments.first();

            if (attachment) {
                const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
                const encryptedChunk = Buffer.from(response.data);

                // Decrypt chunk
                const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, iv);
                let decryptedChunk = decipher.update(encryptedChunk);
                decryptedChunk = Buffer.concat([decryptedChunk, decipher.final()]);

                decryptedChunks.push(decryptedChunk);
            } else {
                res.status(500).send(`Attachment not found for chunk ${i + 1}`);
                return;
            }
        }

        const originalContent = Buffer.concat(decryptedChunks);

        res.set({
            'Content-Type': fileType,
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': originalContent.length
        });

        const stream = require('stream');
        const bufferStream = new stream.PassThrough();
        bufferStream.end(originalContent);

        bufferStream.pipe(res);
    });
});

// Endpoint to delete a file
app.delete('/delete/:id', (req, res) => {
    const fileId = req.params.id;

    db.get('SELECT * FROM files WHERE id = ?', [fileId], async (err, row) => {
        if (err) {
            console.error('Error retrieving file information from database:', err);
            res.status(500).send('Error retrieving file information.');
            return;
        }

        if (!row) {
            res.status(404).send('File not found.');
            return;
        }

        const messageIds = JSON.parse(row.messageIds);

        try {
            for (const messageId of messageIds) {
                const message = await client.channels.cache.get(channelId).messages.fetch(messageId);
                if (message) {
                    await message.delete();
                }
            }

            db.run('DELETE FROM files WHERE id = ?', [fileId], (err) => {
                if (err) {
                    console.error('Error deleting file information from database:', err);
                    res.status(500).send('Error deleting file information.');
                    return;
                }

                res.status(200).send('File deleted successfully.');
            });
        } catch (err) {
            console.error('Error deleting file from Discord:', err);
            res.status(500).send('Error deleting file from Discord.');
        }
    });
});

// Endpoint to list all uploaded files with total file size
app.get('/files', (req, res) => {
    db.all('SELECT * FROM files', (err, rows) => {
        if (err) {
            console.error('Error retrieving files from database:', err);
            res.status(500).send('Error retrieving files.');
            return;
        }

        let totalSize = 0;
        rows.forEach(row => {
            totalSize += row.fileSize;
        });

        res.json({ files: rows, totalSize: totalSize });
    });
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

const os = require('os');

const interfaces = os.networkInterfaces();
let localIpAddress = '127.0.0.1';

for (let iface in interfaces) {
    for (let alias of interfaces[iface]) {
        if (alias.family === 'IPv4' && !alias.internal) {
            localIpAddress = alias.address;
        }
    }
}

app.listen(port, localIpAddress, () => {
    console.log(`Server is running at http://${localIpAddress}:${port}`);
});
