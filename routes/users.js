var express = require('express');
var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');
var helpers = require('./helpers');
var router = express.Router();

async function saveUser(req, session) {
    var user = req.params.id
        ? await helpers.findResource(User, req.params.id, session)
        : new User();
    var body = helpers.readBody(req);
    user.set({
        name: body.name,
        email: body.email,
        pendingTasks: body.pendingTasks === undefined ? [] : body.pendingTasks
    });
    await user.validate();
    user.pendingTasks = [...new Set(user.pendingTasks.map(function (id) {
        return id.toLowerCase();
    }))];
    if (await User.exists({ email: user.email, _id: { $ne: user._id } }).session(session)) {
        helpers.fail(400, 'Email is already in use');
    }
    var tasks = await Task.find({ _id: { $in: user.pendingTasks } }).session(session);
    if (tasks.length !== user.pendingTasks.length) {
        helpers.fail(404, 'A referenced task was not found');
    }
    if (tasks.some(function (task) { return task.completed; })) {
        helpers.fail(400, 'pendingTasks cannot include completed tasks');
    }
    await user.save({ session: session });
    var id = user._id.toString();
    if (user.pendingTasks.length) {
        await User.updateMany(
            { _id: { $ne: user._id }, pendingTasks: { $in: user.pendingTasks } },
            { $pull: { pendingTasks: { $in: user.pendingTasks } } },
            { session: session }
        );
    }
    await Task.updateMany(
        { assignedUser: id, completed: false, _id: { $nin: user.pendingTasks } },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
        { session: session }
    );
    await Task.updateMany(
        { _id: { $in: user.pendingTasks } },
        { $set: { assignedUser: id, assignedUserName: user.name } },
        { session: session }
    );
    await Task.updateMany(
        { assignedUser: id },
        { $set: { assignedUserName: user.name } },
        { session: session }
    );
    return user.toObject();
}

router.get('/', async function (req, res) {
    var users = await helpers.listResources(User, req.query);
    res.status(200).json({ message: 'OK', data: users });
});

router.post('/', async function (req, res) {
    var user = await mongoose.connection.transaction(function (session) {
        return saveUser(req, session);
    });
    res.status(201).json({ message: 'User created', data: user });
});

router.get('/:id', async function (req, res) {
    var user = await helpers.getResource(User, req.params.id, req.query);
    res.status(200).json({ message: 'OK', data: user });
});

router.put('/:id', async function (req, res) {
    var user = await mongoose.connection.transaction(function (session) {
        return saveUser(req, session);
    });
    res.status(200).json({ message: 'User updated', data: user });
});

router.delete('/:id', async function (req, res) {
    var user = await mongoose.connection.transaction(async function (session) {
        var existing = await helpers.findResource(User, req.params.id, session);
        await Task.updateMany(
            { assignedUser: existing._id.toString() },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
            { session: session }
        );
        await existing.deleteOne({ session: session });
        return existing.toObject();
    });
    res.status(200).json({ message: 'User deleted', data: user });
});

module.exports = router;
