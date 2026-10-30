var mongoose = require('mongoose');

var TaskSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        cast: false
    },
    description: {
        type: String,
        default: '',
        cast: false,
        validate: {
            validator: function (value) {
                return typeof value === 'string';
            }
        }
    },
    deadline: {
        type: Date,
        required: true
    },
    completed: {
        type: Boolean,
        required: true,
        default: false,
        cast: false
    },
    assignedUser: {
        type: String,
        default: '',
        cast: false,
        validate: {
            validator: function (id) {
                return typeof id === 'string' && (id === '' || /^[a-fA-F0-9]{24}$/.test(id));
            }
        }
    },
    assignedUserName: {
        type: String,
        default: 'unassigned',
        cast: false,
        validate: {
            validator: function (value) {
                return typeof value === 'string';
            }
        }
    },
    dateCreated: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

TaskSchema.pre('validate', function () {
    if (this.isNew) {
        this.dateCreated = new Date();
    }
});

module.exports = mongoose.model('Task', TaskSchema);
