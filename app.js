const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 3000;
const os = require('os');
const networkInterfaces = os.networkInterfaces();

// Set up storage directory
const UPLOAD_DIR = 'uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
}

// Configure Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({ storage: storage });

// Serve static files
app.use(express.static('public'));

// Endpoint for file upload
app.post('/upload', upload.array('files', 10), (req, res) => {
    res.status(200).send('Files uploaded successfully');
});

// Endpoint to list uploaded files
app.get('/files', (req, res) => {
    fs.readdir(UPLOAD_DIR, (err, files) => {
        if (err) {
            return res.status(500).send('Unable to scan files');
        }

        const fileList = files.map(fileName => {
            const filePath = path.join(UPLOAD_DIR, fileName);
            const fileStat = fs.statSync(filePath);
            return {
                id: fileName,
                fileName,
                fileSize: fileStat.size
            };
        });

        const totalSize = fileList.reduce((acc, file) => acc + file.fileSize, 0);
        res.json({ files: fileList, totalSize });
    });
});

// Endpoint to download a file
app.get('/download/:id', (req, res) => {
    const fileId = req.params.id;
    const filePath = path.join(UPLOAD_DIR, fileId);
    if (fs.existsSync(filePath)) {
        res.download(filePath, fileId, (err) => {
            if (err) {
                res.status(500).send('Error downloading file');
            }
        });
    } else {
        res.status(404).send('File not found');
    }
});

// Endpoint to delete a file
app.delete('/delete/:id', (req, res) => {
    const fileId = req.params.id;
    const filePath = path.join(UPLOAD_DIR, fileId);
    if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) {
                res.status(500).send('Error deleting file');
            } else {
                res.send('File deleted successfully');
            }
        });
    } else {
        res.status(404).send('File not found');
    }
});

// Get local IP address
let localIpAddress = '127.0.0.1'; // Default to localhost
for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name]) {
        // Skip over non-ipv4 and internal (i.e., 127.0.0.1) addresses
        if (net.family === 'IPv4' && !net.internal) {
            localIpAddress = net.address;
        }
    }
}

// Server startup
app.listen(port, () => {
    console.log(`Server is running on http://${localIpAddress}:${port}`);
});
