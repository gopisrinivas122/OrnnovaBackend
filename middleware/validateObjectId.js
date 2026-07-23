const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const validateObjectId = (id, res, label = 'ID') => {
  if (!id || !isValidObjectId(id)) {
    res.status(400).json({ status: 'Failed', msg: `Invalid ${label} format` });
    return false;
  }
  return true;
};

module.exports = { isValidObjectId, validateObjectId };
