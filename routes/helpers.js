var mongoose = require('mongoose');

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function fail(status, message) {
    throw new ApiError(status, message);
}

function readBody(req) {
    var body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        fail(400, 'Request body must be an object');
    }
    body = { ...body };
    if (req.is('application/x-www-form-urlencoded')) {
        if (body.completed === 'true' || body.completed === 'false') {
            body.completed = body.completed === 'true';
        }
        if (typeof body.pendingTasks === 'string') {
            try {
                body.pendingTasks = JSON.parse(body.pendingTasks);
            } catch (error) {
                fail(400, 'pendingTasks must be a list of task IDs');
            }
        }
    }
    return body;
}

async function findResource(Model, id, session) {
    if (typeof id !== 'string' || !mongoose.isObjectIdOrHexString(id)) {
        fail(404, Model.modelName + ' not found');
    }
    var resource = await Model.findById(id).session(session);
    if (!resource) {
        fail(404, Model.modelName + ' not found');
    }
    return resource;
}

function parseParameter(query, key, fallback) {
    if (query[key] === undefined) {
        return fallback;
    }
    if (typeof query[key] !== 'string') {
        fail(400, 'Invalid ' + key + ' parameter');
    }
    try {
        return JSON.parse(query[key]);
    } catch (error) {
        fail(400, 'Invalid JSON in ' + key);
    }
}

function objectParameter(query, key) {
    var value = parseParameter(query, key, {});
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(400, key + ' must be an object');
    }
    return value;
}

function validateFieldPaths(fields, parameter) {
    Object.keys(fields).forEach(function (field) {
        if (parameter === 'sort' && field === '$natural') {
            return;
        }
        if (/^[+-]/.test(field) || field.split('.').some(function (part) {
            return !part || part.startsWith('$') || part.includes('\0');
        })) {
            fail(400, parameter + ' contains an invalid field path');
        }
    });
}

function validateFilter(filter) {
    Object.entries(filter).forEach(function ([key, value]) {
        if (key === '$and' || key === '$or' || key === '$nor') {
            if (!Array.isArray(value) || !value.length || value.some(function (item) {
                return !item || typeof item !== 'object' || Array.isArray(item);
            })) {
                fail(400, key + ' must contain a nonempty list of query objects');
            }
            value.forEach(validateFilter);
        } else if (!key.startsWith('$') && value && typeof value === 'object' && !Array.isArray(value)) {
            if (Object.hasOwn(value, '$elemMatch')) {
                if (!value.$elemMatch || typeof value.$elemMatch !== 'object' || Array.isArray(value.$elemMatch)) {
                    fail(400, '$elemMatch must be a query object');
                }
                validateFilter(value.$elemMatch);
            }
        }
    });
}

async function executeQuery(query) {
    try {
        query.cast(query.model);
    } catch (error) {
        fail(400, 'Invalid where parameter or query field value');
    }
    try {
        return await query.exec();
    } catch (error) {
        if (error.name === 'MongoServerError' && [2, 9, 14, 72, 168, 31249, 31250, 40352, 51091, 51108].includes(error.code)) {
            fail(400, 'Invalid query parameters');
        }
        throw error;
    }
}

function projection(query) {
    var select = objectParameter(query, 'select');
    validateFieldPaths(select, 'select');
    if (Object.values(select).some(function (value) {
        return value !== 0 && value !== 1;
    })) {
        fail(400, 'select values must be 0 or 1');
    }
    var modes = new Set(Object.entries(select).filter(function ([key]) {
        return key !== '_id';
    }).map(function ([key, value]) {
        return value;
    }));
    if (modes.size > 1) {
        fail(400, 'select cannot mix included and excluded fields');
    }
    var fields = new Set(Object.keys(select));
    fields.forEach(function (field) {
        var path = field;
        while (path.includes('.')) {
            path = path.slice(0, path.lastIndexOf('.'));
            if (fields.has(path)) {
                fail(400, 'select cannot include overlapping field paths');
            }
        }
    });
    return select;
}

async function listResources(Model, query) {
    var where = objectParameter(query, 'where');
    var sort = objectParameter(query, 'sort');
    var select = projection(query);
    var skip = parseParameter(query, 'skip', 0);
    var limit = parseParameter(query, 'limit', Model.modelName === 'Task' ? 100 : 0);
    var count = parseParameter(query, 'count', false);
    validateFilter(where);
    validateFieldPaths(sort, 'sort');
    if (Object.values(sort).some(function (value) {
        return value !== 1 && value !== -1;
    })) {
        fail(400, 'sort values must be 1 or -1');
    }
    if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 0) {
        fail(400, 'skip and limit must be nonnegative integers');
    }
    if (typeof count !== 'boolean') {
        fail(400, 'count must be a boolean');
    }
    if (count) {
        return executeQuery(Model.countDocuments(where));
    }
    return executeQuery(Model.find(where).sort(sort).select(select).skip(skip).limit(limit));
}

async function getResource(Model, id, query) {
    if (typeof id !== 'string' || !mongoose.isObjectIdOrHexString(id)) {
        fail(404, Model.modelName + ' not found');
    }
    var resource = await executeQuery(Model.findById(id).select(projection(query)));
    if (!resource) {
        fail(404, Model.modelName + ' not found');
    }
    return resource;
}

function validationMessage(error) {
    var messages = Object.values(error.errors).map(function (issue) {
        var field = issue.path.split('.')[0];
        if (issue.kind === 'required' && ['name', 'email', 'deadline'].includes(field)) {
            return field + ' is required';
        }
        if (['name', 'email', 'description', 'assignedUserName'].includes(field)) {
            return field + ' must be a string';
        }
        if (field === 'pendingTasks') {
            return 'pendingTasks must be a list of valid task IDs';
        }
        if (field === 'assignedUser') {
            return 'assignedUser must be empty or a valid user ID';
        }
        if (field === 'deadline') {
            return 'deadline must be a valid date';
        }
        if (field === 'completed') {
            return 'completed must be a boolean';
        }
        return 'Invalid field values';
    });
    return [...new Set(messages)].join('; ') || 'Invalid field values';
}

function errorHandler(error, req, res, next) {
    if (res.headersSent) {
        return next(error);
    }
    var status = 500;
    var message = 'An unexpected server error occurred';
    if (error instanceof ApiError) {
        status = error.status;
        message = error.message;
    } else if (error.type === 'entity.parse.failed') {
        status = 400;
        message = 'Invalid JSON request body';
    } else if (error.type === 'entity.too.large') {
        status = 413;
        message = 'Request body is too large';
    } else if (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported') {
        status = 415;
        message = 'Unsupported request encoding';
    } else if (error.code === 11000) {
        status = 400;
        message = 'Email is already in use';
    } else if (error.name === 'ValidationError') {
        status = 400;
        message = validationMessage(error);
    } else if (error.name === 'CastError') {
        status = 400;
        message = 'Invalid field values';
    }
    res.status(status).json({ message: message, data: null });
}

module.exports = { fail, readBody, findResource, listResources, getResource, errorHandler };
