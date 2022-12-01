const { cleanBy } = require("deep-cleaner");

/**
 *
 * @param {Object} object the object to scrum
 * @param {string[]} keys the keys to filter from the object
 */
exports.scrubObject = (object, ...keys) => {
    const scrubbedObject = {};

    Object.assign(scrubbedObject, object);

    cleanBy(scrubbedObject, keys);

    return scrubbedObject;
};

exports.booleanToYN = (bool) => (bool ? "Yes" : "No");
