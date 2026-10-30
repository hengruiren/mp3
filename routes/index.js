/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    app.use('/api', require('./home.js')(router));
    app.use('/api/users', require('./users'));
    app.use('/api/tasks', require('./tasks'));
    app.use(function (req, res) {
        res.status(404).json({ message: 'Endpoint not found', data: null });
    });
    app.use(require('./helpers').errorHandler);
};
