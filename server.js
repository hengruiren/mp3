// Get the packages we need
var express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose');

// Read .env file
require('dotenv').config();

// Create our Express application
var app = express();

// Use environment defined port or 3000
var port = process.env.PORT || 3000;

// Allow CORS so that backend and frontend could be put on different servers
var allowCrossDomain = function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
};
app.use(allowCrossDomain);

// Parse URL-encoded and JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Use routes as a module (see index.js)
require('./routes')(app, router);

// Start accepting requests only after the database is connected.
async function startServer() {
    if (!process.env.MONGODB_URI) {
        console.error('Missing MONGODB_URI. Set it in your .env file.');
        process.exitCode = 1;
        return;
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 10000
        });
        await require('./models/user').init();
        await require('./models/task').init();
    } catch (err) {
        console.error('MongoDB connection failed. Check your credentials, network access and Atlas IP access list.');
        await mongoose.disconnect();
        process.exitCode = 1;
        return;
    }

    console.log('MongoDB connected');
    app.listen(port, function () {
        console.log('Server running on port ' + port);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = app;
