const Joi = require('joi');
const { ApiError } = require('./errorHandler');

const validate = (schema, source = 'query') => {
  return (req, res, next) => {
    const data = req[source];
    const { error, value } = schema.validate(data, { abortEarly: false });
    if (error) {
      const details = error.details.map(d => d.message);
      return next(new ApiError(400, 'Validation failed', 'VALIDATION_ERROR', details));
    }
    req[source] = value;
    next();
  };
};

module.exports = validate;
