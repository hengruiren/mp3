var express = require('express');
var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');
var helpers = require('./helpers');
var router = express.Router();

async function saveTask(req, session) {
    var task = req.params.id
        ? await helpers.findResource(Task, req.params.id, session)
        : new Task();
    var body = helpers.readBody(req);
    if (body.deadline !== undefined && typeof body.deadline !== 'string' && typeof body.deadline !== 'number') {
        helpers.fail(400, 'deadline must be a valid date');
    }
    task.set({
        name: body.name,
        description: body.description === undefined ? '' : body.description,
        deadline: body.deadline,
        completed: body.completed === undefined ? false : body.completed,
        assignedUser: body.assignedUser === undefined ? '' : body.assignedUser,
        assignedUserName: body.assignedUserName === undefined ? 'unassigned' : body.assignedUserName
    });
    await task.validate();
    if (task.assignedUser) {
        var user = await helpers.findResource(User, task.assignedUser, session);
        if (body.assignedUserName !== undefined && task.assignedUserName !== user.name) {
            helpers.fail(400, 'assignedUserName must match the assigned user');
        }
        await User.updateOne(
            { _id: user._id },
            { $inc: { __v: 1 } },
            { session: session }
        );
        task.assignedUser = user._id.toString();
        task.assignedUserName = user.name;
    } else {
        task.assignedUserName = 'unassigned';
    }
    await task.save({ session: session });
    var id = task._id.toString();
    await User.updateMany(
        { pendingTasks: id },
        { $pull: { pendingTasks: id } },
        { session: session }
    );
    if (task.assignedUser && !task.completed) {
        await User.updateOne(
            { _id: task.assignedUser },
            { $addToSet: { pendingTasks: id } },
            { session: session }
        );
    }
    return task.toObject();
}

router.get('/', async function (req, res) {
    var tasks = await helpers.listResources(Task, req.query);
    res.status(200).json({ message: 'OK', data: tasks });
});

router.post('/', async function (req, res) {
    var task = await mongoose.connection.transaction(function (session) {
        return saveTask(req, session);
    });
    res.status(201).json({ message: 'Task created', data: task });
});

router.get('/:id', async function (req, res) {
    var task = await helpers.getResource(Task, req.params.id, req.query);
    res.status(200).json({ message: 'OK', data: task });
});

router.put('/:id', async function (req, res) {
    var task = await mongoose.connection.transaction(function (session) {
        return saveTask(req, session);
    });
    res.status(200).json({ message: 'Task updated', data: task });
});

router.delete('/:id', async function (req, res) {
    await mongoose.connection.transaction(async function (session) {
        var existing = await helpers.findResource(Task, req.params.id, session);
        await User.updateMany(
            { pendingTasks: existing._id.toString() },
            { $pull: { pendingTasks: existing._id.toString() } },
            { session: session }
        );
        await existing.deleteOne({ session: session });
    });
    res.status(204).end();
});

module.exports = router;
