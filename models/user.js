// Load required packages
var mongoose = require('mongoose');

// Define our user schema
var UserSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        cast: false
    },
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        cast: false
    },
    pendingTasks: {
        type: [{ type: String, cast: false }],
        default: [],
        castNonArrays: false,
        validate: {
            validator: function (ids) {
                return Array.isArray(ids) && ids.every(function (id) {
                    return typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id);
                });
            }
        }
    },
    dateCreated: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

UserSchema.pre('validate', function () {
    if (this.isNew) {
        this.dateCreated = new Date();
    }
});

// Export the Mongoose model
module.exports = mongoose.model('User', UserSchema);
