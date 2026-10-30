var assert = require('node:assert/strict');
var { before, after, test } = require('node:test');
var { once } = require('node:events');
var mongoose = require('mongoose');
var app = require('../server');
var User = require('../models/user');
var Task = require('../models/task');
var helpers = require('../routes/helpers');
var database = 'mp3_api_test_' + Date.now() + '_' + process.pid;
var server;
var base;
var sequence = 0;
var deadline = '2026-11-03T23:59:00-06:00';

before(async function () {
    await mongoose.connect(process.env.MONGODB_URI, {
        dbName: database,
        serverSelectionTimeoutMS: 10000
    });
    await User.init();
    await Task.init();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port + '/api';
});

after(async function () {
    try {
        if (server) {
            await new Promise(function (resolve, reject) {
                server.close(function (error) { error ? reject(error) : resolve(); });
            });
        }
        if (mongoose.connection.name === database && mongoose.connection.readyState === 1) {
            await mongoose.connection.dropDatabase();
        }
    } finally {
        await mongoose.disconnect();
    }
});

async function request(method, path, body, status = 200) {
    var response = await fetch(base + path, {
        method: method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
    });
    var result = await response.json();
    assert.equal(response.status, status, method + ' ' + path + ': ' + result.message);
    assert.equal(typeof result.message, 'string');
    assert.ok(Object.hasOwn(result, 'data'));
    return result.data;
}

function query(parameters) {
    return '?' + new URLSearchParams(Object.entries(parameters).map(function ([key, value]) {
        return [key, JSON.stringify(value)];
    }));
}

function createUser(name = 'Alice', extra = {}) {
    return request('POST', '/users', {
        name: name,
        email: 'user' + (++sequence) + '@example.com',
        ...extra
    }, 201);
}

function createTask(extra = {}) {
    return request('POST', '/tasks', { name: 'Homework', deadline: deadline, ...extra }, 201);
}

async function snapshot() {
    return JSON.stringify({
        users: await User.find().sort({ _id: 1 }).lean(),
        tasks: await Task.find().sort({ _id: 1 }).lean()
    });
}

test('users support create, read, replace and delete', async function () {
    var user = await createUser('Alice', { dateCreated: '2000-01-01' });
    assert.deepEqual(user.pendingTasks, []);
    assert.notEqual(user.dateCreated, '2000-01-01T00:00:00.000Z');
    assert.equal((await request('GET', '/users/' + user._id)).name, 'Alice');
    var users = await request('GET', '/users');
    assert.ok(users.some(function (entry) { return entry._id === user._id; }));
    var updated = await request('PUT', '/users/' + user._id, {
        name: 'Alicia', email: user.email, dateCreated: '2000-01-01'
    });
    assert.equal(updated.name, 'Alicia');
    assert.equal(updated.dateCreated, user.dateCreated);
    assert.deepEqual(updated.pendingTasks, []);
    await request('DELETE', '/users/' + user._id);
    await request('GET', '/users/' + user._id, undefined, 404);
    await request('DELETE', '/users/' + user._id, undefined, 404);
});

test('tasks use replacement defaults and preserve creation dates', async function () {
    var task = await createTask({ description: 'Details', completed: true, dateCreated: '2000-01-01' });
    assert.equal(task.assignedUser, '');
    assert.equal(task.assignedUserName, 'unassigned');
    assert.notEqual(task.dateCreated, '2000-01-01T00:00:00.000Z');
    assert.equal((await request('GET', '/tasks/' + task._id)).description, 'Details');
    var tasks = await request('GET', '/tasks');
    assert.ok(tasks.some(function (entry) { return entry._id === task._id; }));
    var updated = await request('PUT', '/tasks/' + task._id, {
        name: 'Revised', deadline: deadline, dateCreated: '2000-01-01'
    });
    assert.equal(updated.description, '');
    assert.equal(updated.completed, false);
    assert.equal(updated.dateCreated, task.dateCreated);
    await request('DELETE', '/tasks/' + task._id);
    await request('GET', '/tasks/' + task._id, undefined, 404);
});

test('task assignment, completion, reopening and deletion synchronize users', async function () {
    var alice = await createUser();
    var bob = await createUser('Bob');
    var task = await createTask({ assignedUser: alice._id });
    assert.equal(task.assignedUserName, alice.name);
    assert.deepEqual((await request('GET', '/users/' + alice._id)).pendingTasks, [task._id]);
    var body = { name: task.name, deadline: deadline, assignedUser: bob._id, completed: true };
    await request('PUT', '/tasks/' + task._id, body);
    assert.deepEqual((await request('GET', '/users/' + alice._id)).pendingTasks, []);
    assert.deepEqual((await request('GET', '/users/' + bob._id)).pendingTasks, []);
    assert.equal((await request('GET', '/tasks/' + task._id)).assignedUser, bob._id);
    body.completed = false;
    await request('PUT', '/tasks/' + task._id, body);
    assert.deepEqual((await request('GET', '/users/' + bob._id)).pendingTasks, [task._id]);
    await request('DELETE', '/tasks/' + task._id);
    assert.deepEqual((await request('GET', '/users/' + bob._id)).pendingTasks, []);
});

test('user replacement moves tasks, propagates names and unassigns removed tasks', async function () {
    var alice = await createUser();
    var pending = await createTask({ assignedUser: alice._id });
    var done = await createTask({ assignedUser: alice._id, completed: true });
    await request('PUT', '/users/' + alice._id, {
        name: 'Alicia', email: alice.email, pendingTasks: [pending._id]
    });
    assert.equal((await request('GET', '/tasks/' + pending._id)).assignedUserName, 'Alicia');
    assert.equal((await request('GET', '/tasks/' + done._id)).assignedUserName, 'Alicia');
    var bob = await createUser('Bob', { pendingTasks: [pending._id, pending._id.toUpperCase()] });
    assert.deepEqual(bob.pendingTasks, [pending._id]);
    assert.deepEqual((await request('GET', '/users/' + alice._id)).pendingTasks, []);
    assert.equal((await request('GET', '/tasks/' + pending._id)).assignedUser, bob._id);
    await request('PUT', '/users/' + bob._id, { name: bob.name, email: bob.email });
    assert.equal((await request('GET', '/tasks/' + pending._id)).assignedUser, '');
    await request('DELETE', '/users/' + alice._id);
    var completed = await request('GET', '/tasks/' + done._id);
    assert.equal(completed.assignedUser, '');
    assert.equal(completed.assignedUserName, 'unassigned');
});

test('invalid requests use correct statuses and leave stored data unchanged', async function () {
    var user = await createUser();
    var task = await createTask({ assignedUser: user._id });
    var done = await createTask({ completed: true });
    var missing = new mongoose.Types.ObjectId().toString();
    var original = await snapshot();
    var cases = [
        ['POST', '/users', { name: 'Missing email' }, 400],
        ['POST', '/users', { name: 123, email: 'invalid@example.com' }, 400],
        ['POST', '/users', { name: 'Duplicate', email: user.email }, 400],
        ['POST', '/tasks', { name: 'Missing deadline' }, 400],
        ['POST', '/tasks', { name: 'Bad date', deadline: 'invalid' }, 400],
        ['PUT', '/users/bad-id', {}, 404],
        ['PUT', '/tasks/' + missing, {}, 404],
        ['GET', '/tasks/bad-id', undefined, 404],
        ['DELETE', '/users/' + missing, undefined, 404],
        ['PUT', '/users/' + user._id, { name: user.name, email: user.email, pendingTasks: ['bad-id'] }, 400],
        ['PUT', '/users/' + user._id, { name: user.name, email: user.email, pendingTasks: [missing] }, 404],
        ['PUT', '/users/' + user._id, { name: user.name, email: user.email, pendingTasks: [done._id] }, 400],
        ['PUT', '/tasks/' + task._id, { name: task.name, deadline: deadline, assignedUser: 'bad-id' }, 400],
        ['PUT', '/tasks/' + task._id, { name: task.name, deadline: deadline, assignedUser: missing }, 404],
        ['PUT', '/tasks/' + task._id, { name: task.name, deadline: deadline, assignedUser: user._id, assignedUserName: 'Wrong' }, 400],
        ['PUT', '/tasks/' + task._id, { name: task.name, deadline: deadline, completed: 'false' }, 400]
    ];
    for (var entry of cases) {
        await request(...entry);
        assert.equal(await snapshot(), original);
    }
    var response = await fetch(base + '/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
    });
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(await response.json()).sort(), ['data', 'message']);
    assert.equal(await snapshot(), original);
});

test('collection queries combine filtering, sorting, projection, pagination and counts', async function () {
    var ids = [];
    for (var name of ['Query C', 'Query A', 'Query B']) {
        ids.push((await createTask({ name: name }))._id);
    }
    var where = { _id: { $in: ids } };
    var tasks = await request('GET', '/tasks' + query({
        where: where, sort: { name: 1 }, select: { name: 1, _id: 0 }, skip: 1, limit: 1
    }));
    assert.deepEqual(tasks, [{ name: 'Query B' }]);
    assert.equal(await request('GET', '/tasks' + query({ where: where, count: true, limit: 1 })), 3);
    assert.deepEqual(await request('GET', '/users' + query({ where: { _id: new mongoose.Types.ObjectId().toString() } })), []);
    var selected = await request('GET', '/tasks/' + ids[0] + query({ select: { name: 1, _id: 0 } }) + '&where=invalid&count=invalid');
    assert.deepEqual(selected, { name: 'Query C' });
    await request('GET', '/tasks?where=invalid', undefined, 400);
    await request('GET', '/tasks?limit=-1', undefined, 400);
    await request('GET', '/tasks?select={"name":1,"description":0}', undefined, 400);
    var user = await createUser();
    assert.deepEqual(await request('GET', '/users/' + user._id + query({ select: { email: 1, _id: 0 } })), { email: user.email });
});

test('transactions roll back failures after a document has been written', async function () {
    var original = await snapshot();
    var updateMany = Task.updateMany;
    try {
        Task.updateMany = async function () { throw new Error('Injected write failure'); };
        var result = await request('POST', '/users', { name: 'Rollback', email: 'rollback@example.com' }, 500);
        assert.equal(result, null);
    } finally {
        Task.updateMany = updateMany;
    }
    assert.equal(await snapshot(), original);
});

test('concurrent duplicate email requests create only one user', async function () {
    var body = { name: 'Concurrent', email: 'concurrent@example.com' };
    var statuses = await Promise.all([1, 2].map(async function () {
        var response = await fetch(base + '/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        await response.json();
        return response.status;
    }));
    assert.deepEqual(statuses.sort(), [201, 400]);
    assert.equal(await User.countDocuments({ email: body.email }), 1);
});

test('pending tasks transfer between users without duplicate references', async function () {
    var alice = await createUser();
    var bob = await createUser('Bob');
    var task = await createTask({ assignedUser: alice._id });
    var other = await createTask({ assignedUser: alice._id });
    var body = { name: task.name, deadline: deadline, assignedUser: bob._id };
    await request('PUT', '/tasks/' + task._id, body);
    await request('PUT', '/tasks/' + task._id, body);
    assert.deepEqual((await request('GET', '/users/' + alice._id)).pendingTasks, [other._id]);
    assert.deepEqual((await request('GET', '/users/' + bob._id)).pendingTasks, [task._id]);
    assert.equal((await request('GET', '/tasks/' + task._id)).assignedUserName, bob.name);
    body.assignedUser = '';
    body.assignedUserName = bob.name;
    var unassigned = await request('PUT', '/tasks/' + task._id, body);
    assert.equal(unassigned.assignedUser, '');
    assert.equal(unassigned.assignedUserName, 'unassigned');
    assert.deepEqual((await request('GET', '/users/' + bob._id)).pendingTasks, []);
});

test('completion keeps ownership and completed tasks can transfer and reopen', async function () {
    var alice = await createUser();
    var bob = await createUser('Bob');
    var task = await createTask({ assignedUser: alice._id });
    var body = { name: task.name, deadline: deadline, assignedUser: alice._id, completed: true };
    var completed = await request('PUT', '/tasks/' + task._id, body);
    assert.equal(completed.assignedUser, alice._id);
    assert.deepEqual((await request('GET', '/users/' + alice._id)).pendingTasks, []);
    body.assignedUser = bob._id;
    completed = await request('PUT', '/tasks/' + task._id, body);
    assert.equal(completed.assignedUserName, bob.name);
    assert.deepEqual((await request('GET', '/users/' + bob._id)).pendingTasks, []);
    body.completed = false;
    await request('PUT', '/tasks/' + task._id, body);
    assert.deepEqual((await request('GET', '/users/' + bob._id)).pendingTasks, [task._id]);
});

test('updating pendingTasks moves tasks and preserves completed ownership', async function () {
    var alice = await createUser();
    var bob = await createUser('Bob');
    var moved = await createTask({ assignedUser: alice._id });
    var removed = await createTask({ assignedUser: bob._id });
    var kept = await createTask({ assignedUser: bob._id });
    var completed = await createTask({ assignedUser: bob._id, completed: true });
    await request('PUT', '/users/' + bob._id, {
        name: 'Robert', email: bob.email, pendingTasks: [kept._id, moved._id]
    });
    assert.deepEqual((await request('GET', '/users/' + alice._id)).pendingTasks, []);
    assert.equal((await request('GET', '/tasks/' + removed._id)).assignedUser, '');
    for (var id of [kept._id, moved._id, completed._id]) {
        var task = await request('GET', '/tasks/' + id);
        assert.equal(task.assignedUser, bob._id);
        assert.equal(task.assignedUserName, 'Robert');
    }
    assert.deepEqual((await request('GET', '/users/' + bob._id)).pendingTasks, [kept._id, moved._id]);
});

test('deleting a user unassigns pending and completed tasks without affecting other users', async function () {
    var alice = await createUser();
    var bob = await createUser('Bob');
    var pending = await createTask({ assignedUser: alice._id });
    var completed = await createTask({ assignedUser: alice._id, completed: true });
    var other = await createTask({ assignedUser: bob._id });
    await request('DELETE', '/users/' + alice._id);
    for (var id of [pending._id, completed._id]) {
        var task = await request('GET', '/tasks/' + id);
        assert.equal(task.assignedUser, '');
        assert.equal(task.assignedUserName, 'unassigned');
    }
    assert.equal((await request('GET', '/tasks/' + completed._id)).completed, true);
    assert.deepEqual((await request('GET', '/users/' + bob._id)).pendingTasks, [other._id]);
});

test('task writes and deletes roll back when reference synchronization fails', async function () {
    var user = await createUser();
    var task = await createTask({ assignedUser: user._id });
    var original = await snapshot();
    var updateMany = User.updateMany;
    try {
        User.updateMany = async function () { throw new Error('Injected reference failure'); };
        await request('POST', '/tasks', { name: 'Rollback', deadline: deadline, assignedUser: user._id }, 500);
        await request('PUT', '/tasks/' + task._id, {
            name: task.name, deadline: deadline, completed: true, assignedUser: user._id
        }, 500);
        await request('DELETE', '/tasks/' + task._id, undefined, 500);
    } finally {
        User.updateMany = updateMany;
    }
    assert.equal(await snapshot(), original);
    var deleteOne = User.prototype.deleteOne;
    try {
        User.prototype.deleteOne = async function () { throw new Error('Injected deletion failure'); };
        await request('DELETE', '/users/' + user._id, undefined, 500);
    } finally {
        User.prototype.deleteOne = deleteOne;
    }
    assert.equal(await snapshot(), original);
});

test('a completed task cannot retain a user deleted during assignment', async function () {
    var user = await createUser();
    var findResource = helpers.findResource;
    var pause;
    var resume;
    var ready = new Promise(function (resolve) { pause = resolve; });
    var released = new Promise(function (resolve) { resume = resolve; });
    var paused = false;
    var response;
    try {
        helpers.findResource = async function (Model, id, session) {
            var result = await findResource(Model, id, session);
            if (Model === User && id === user._id && !paused) {
                paused = true;
                pause();
                await released;
            }
            return result;
        };
        response = fetch(base + '/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Concurrent assignment', deadline: deadline, assignedUser: user._id, completed: true }),
            signal: AbortSignal.timeout(20000)
        });
        await Promise.race([ready, response.then(function () {
            throw new Error('Assignment finished before the user lookup was paused');
        })]);
        await request('DELETE', '/users/' + user._id);
        resume();
        var result = await response;
        assert.equal(result.status, 404);
        await result.json();
        assert.equal(await Task.countDocuments({ assignedUser: user._id }), 0);
    } finally {
        resume();
        helpers.findResource = findResource;
        if (response) {
            await response.catch(function () {});
        }
    }
});

test('pagination uses resource defaults, supports unlimited results and counts all matches', async function () {
    var tasks = Array.from({ length: 105 }, function (_, index) {
        return { name: 'Page ' + String(index).padStart(3, '0'), deadline: deadline };
    });
    var users = tasks.map(function (task, index) {
        return { name: task.name, email: 'page-user-' + index + '@example.com' };
    });
    await Task.insertMany(tasks);
    await User.insertMany(users);
    var taskFilter = { name: { $regex: '^Page ' } };
    var userFilter = { email: { $regex: '^page-user-' } };
    assert.equal((await request('GET', '/tasks' + query({ where: taskFilter }))).length, 100);
    assert.equal((await request('GET', '/users' + query({ where: userFilter }))).length, 105);
    assert.equal((await request('GET', '/tasks' + query({ where: taskFilter, limit: 0 }))).length, 105);
    assert.deepEqual(await request('GET', '/tasks' + query({
        where: taskFilter, sort: { name: -1 }, select: { name: 1, _id: 0 }, skip: 2, limit: 2
    })), [{ name: 'Page 102' }, { name: 'Page 101' }]);
    assert.deepEqual(await request('GET', '/users' + query({
        where: userFilter, sort: { name: 1 }, select: { name: 1, _id: 0 }, skip: 104, limit: 1
    })), [{ name: 'Page 104' }]);
    assert.equal(await request('GET', '/tasks' + query({ where: taskFilter, skip: 200, limit: 1, count: true })), 105);
    assert.deepEqual(await request('GET', '/tasks' + query({ where: taskFilter, skip: 105 })), []);
    assert.equal(await request('GET', '/users' + query({ where: { name: 'No such user' }, count: true })), 0);
});

test('logical filters, date comparisons and field exclusion combine correctly', async function () {
    var early = await createTask({ name: 'Filter early', deadline: '2026-11-01T00:00:00Z' });
    await createTask({ name: 'Filter late', deadline: '2026-12-01T00:00:00Z' });
    await createTask({ name: 'Filter completed', deadline: '2026-11-01T00:00:00Z', completed: true });
    var results = await request('GET', '/tasks' + query({
        where: { $and: [{ name: { $regex: '^Filter ' } }, { completed: false }, { deadline: { $lt: '2026-11-15T00:00:00Z' } }] },
        select: { description: 0, __v: 0 },
        sort: { deadline: 1, name: -1 }
    }));
    assert.equal(results.length, 1);
    assert.equal(results[0]._id, early._id);
    assert.ok(!Object.hasOwn(results[0], 'description'));
    assert.ok(!Object.hasOwn(results[0], '__v'));
});

test('malformed query shapes and operators are client errors', async function () {
    var cases = [
        { where: [] }, { where: null }, { where: { $or: [] } },
        { where: { $and: [{ name: 'A' }, []] } },
        { where: { $invalid: true } }, { where: { name: { $invalid: 1 } } },
        { where: { name: { $regex: '[' } } }, { where: { name: { $size: 1 } } },
        { where: { name: { $regex: '.', $options: 'z' } } },
        { where: { _id: 'invalid' } },
        { sort: [] }, { sort: { name: 0 } }, { sort: { '': 1 } },
        { select: [] }, { select: { name: true } }, { select: { '': 1 } },
        { select: { name: 1, 'name.first': 1 } },
        { select: { name: 1, 'name-foo': 1, 'name.first': 1 }, count: true },
        { skip: -1 }, { skip: 1.5 }, { skip: '1' },
        { limit: -1 }, { limit: null }, { limit: 9007199254740992 },
        { count: 1 }, { count: 'true' }
    ];
    for (var resource of ['users', 'tasks']) {
        for (var parameters of cases) {
            await request('GET', '/' + resource + query(parameters), undefined, 400);
        }
        for (var key of ['where', 'sort', 'select', 'skip', 'limit', 'count']) {
            await request('GET', '/' + resource + '?' + key + '=invalid', undefined, 400);
            await request('GET', '/' + resource + '?' + key + '={}&' + key + '={}', undefined, 400);
        }
    }
});

test('invalid body types and blank required fields preserve data and return useful errors', async function () {
    var original = await snapshot();
    for (var body of [[], null, 'invalid', 123]) {
        await request('POST', '/users', body, 400);
        await request('POST', '/tasks', body, 400);
    }
    for (var field of ['name', 'email']) {
        var body = { name: 'Valid', email: 'validation@example.com', [field]: '   ' };
        var response = await fetch(base + '/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        assert.equal(response.status, 400);
        var result = await response.json();
        assert.ok(result.message.includes(field));
        assert.ok(!/mongoose|mongoerror|cast to|validationerror/i.test(result.message));
        assert.equal(result.data, null);
    }
    await request('POST', '/tasks', { name: 'Invalid', deadline: true }, 400);
    await request('POST', '/tasks', { name: 'Invalid', deadline: deadline, description: {} }, 400);
    await request('POST', '/tasks', { name: 'Invalid', deadline: deadline, completed: 1 }, 400);
    assert.equal(await snapshot(), original);
});

test('form requests convert booleans and task lists without changing JSON type rules', async function () {
    var user = await createUser();
    var task = await createTask();
    var response = await fetch(base + '/users/' + user._id, {
        method: 'PUT', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: user.name, email: user.email, pendingTasks: JSON.stringify([task._id]) })
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.pendingTasks, [task._id]);
    response = await fetch(base + '/tasks/' + task._id, {
        method: 'PUT', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: task.name, deadline: deadline, assignedUser: user._id, completed: 'true' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.completed, true);
    assert.deepEqual((await request('GET', '/users/' + user._id)).pendingTasks, []);
});

test('database failures remain server errors and do not expose internal details', async function () {
    var exec = mongoose.Query.prototype.exec;
    try {
        mongoose.Query.prototype.exec = async function () {
            var error = new Error('Sensitive database configuration and internal details');
            error.name = 'MongoServerError';
            error.code = 91;
            throw error;
        };
        var response = await fetch(base + '/tasks');
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { message: 'An unexpected server error occurred', data: null });
    } finally {
        mongoose.Query.prototype.exec = exec;
    }
});
