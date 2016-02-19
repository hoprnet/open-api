var ADDITIONAL_MIDDLEWARE_PROPERTY = 'x-express-openapi-additional-middleware';
var buildDefaultsMiddleware = require('express-openapi-defaults');
var buildCoercionMiddleware = require('express-openapi-coercion');
var fsRoutes = require('fs-routes');
var INHERIT_ADDITIONAL_MIDDLEWARE_PROPERTY = 'x-express-openapi-inherit-additional-middleware';
var isDir = require('is-dir');
var loggingKey = require('./package.json').name + ': ';
var path = require('path');
var buildValidationMiddleware = require('express-openapi-validation');
var buildResponseValidationMiddleware = require('express-openapi-response-validation');
var validateSchema = require('openapi-schema-validation').validate;

module.exports = {
  initialize: initialize
};

function initialize(args) {
  if (!args) {
    throw new Error(loggingKey + 'args must be an object');
  }

  if (!args.app) {
    throw new Error(loggingKey + 'args.app must be an express app');
  }

  if (!args.apiDoc) {
    throw new Error(loggingKey + 'args.apiDoc is required');
  }

  var exposeApiDocs = 'exposeApiDocs' in args ?
      !!args.exposeApiDocs :
      true;
  var validateApiDoc = 'validateApiDoc' in args ?
      !!args.validateApiDoc :
      true;

  if (validateApiDoc) {
    var apiDocValidation = validateSchema(args.apiDoc);

    if (apiDocValidation.errors.length) {
      console.error(loggingKey, 'Validating schema before populating paths');
      console.error(loggingKey, 'validation errors',
          JSON.stringify(apiDocValidation.errors, null, '  '));
      throw new Error(loggingKey + 'args.apiDoc was invalid.  See the output.');
    }
  }

  if (typeof args.routes !== 'string') {
    throw new Error(loggingKey + 'args.routes must be a string');
  }

  if (!isDir.sync(args.routes)) {
    throw new Error(loggingKey + 'args.routes was not a path to a directory');
  }

  if (args.docsPath && typeof args.docsPath !== 'string') {
    throw new Error(loggingKey + 'args.docsPath must be a string when given');
  }

  if ('errorTransformer' in args && typeof args.errorTransformer !== 'function') {
    throw new Error(loggingKey + 'args.errorTransformer must be a function when given');
  }

  var app = args.app;
  // Do not make modifications to this.
  var originalApiDoc = args.apiDoc;
  // Make a copy of the apiDoc that we can safely modify.
  var apiDoc = copy(args.apiDoc);
  var docsPath = args.docsPath || '/api-docs';
  var routesDir = path.resolve(process.cwd(), args.routes);
  var basePath = apiDoc.basePath || '';
  var errorTransformer = args.errorTransformer;
  var customFormats = args.customFormats;

  fsRoutes(routesDir).forEach(function(result) {
    var pathModule = require(result.path);
    var route = result.route;
    // express path pargumentarams start with :paramName
    // openapi path params use {paramName}
    var openapiPath = route;
    // Do not make modifications to this.
    var originalPathItem = originalApiDoc.paths[openapiPath] || {};
    var pathItem = apiDoc.paths[openapiPath] || {};
    var pathParameters = Array.isArray(pathModule.parameters) ?
        [].concat(pathModule.parameters) :
        [];
    pathItem.parameters = pathParameters;
    apiDoc.paths[openapiPath] = pathItem;

    Object.keys(pathModule).filter(byMethods).forEach(function(methodName) {
      // methodHandler may be an array or a function.
      var methodHandler = pathModule[methodName];
      var methodDoc = methodHandler.apiDoc;
      var middleware = [].concat(getAdditionalMiddleware(originalApiDoc, originalPathItem,
            pathModule, methodDoc), methodHandler);
      (methodDoc && methodDoc.tags || []).forEach(addOperationTagToApiDoc.bind(null, apiDoc));

      if (methodDoc &&
          allowsMiddleware(apiDoc, pathModule, pathItem, methodDoc)) {// add middleware
        pathItem[methodName] = copy(methodDoc);

        if (methodDoc.responses && allowsResponseValidationMiddleware(apiDoc,
              pathModule, pathItem, methodDoc)) {// add response validation middleware
          // it's invalid for a method doc to not have responses, but the post
          // validation will pick it up, so this is almost always going to be added.
          middleware.unshift(buildResponseValidationMiddleware({
            definitions: apiDoc.definitions,
            errorTransformer: errorTransformer,
            responses: methodDoc.responses,
            customFormats: customFormats
          }));
        }

        var methodParameters = Array.isArray(methodDoc.parameters) ?
          withNoDuplicates(pathParameters.concat(methodDoc.parameters)) :
          pathParameters;

        if (methodParameters.length) {// defaults, coercion, and parameter validation middleware
          if (allowsValidationMiddleware(apiDoc, pathModule, pathItem, methodDoc)) {
            var validationMiddleware = buildValidationMiddleware({
              errorTransformer: errorTransformer,
              parameters: methodParameters,
              schemas: apiDoc.definitions,
              customFormats: customFormats
            });
            middleware.unshift(validationMiddleware);
          }

          if (allowsCoercionMiddleware(apiDoc, pathModule, pathItem, methodDoc)) {
            var coercionMiddleware = buildCoercionMiddleware({parameters: methodParameters});
            middleware.unshift(coercionMiddleware);
          }

          // no point in default middleware if we don't have any parameters with defaults.
          if (methodParameters.filter(byDefault).length &&
              allowsDefaultsMiddleware(apiDoc, pathModule, pathItem, methodDoc)) {
            var defaultsMiddleware = buildDefaultsMiddleware({parameters: methodParameters});
            middleware.unshift(defaultsMiddleware);
          }
        }
      }

      var expressPath = basePath + '/' +
          route.substring(1).split('/').map(toExpressParams).join('/');
      app[methodName].apply(app, [expressPath].concat(middleware));
    });
  });

  sortApiDocTags(apiDoc);

  if (validateApiDoc) {
    var apiDocValidation = validateSchema(apiDoc);

    if (apiDocValidation.errors.length) {
      console.error(loggingKey, 'Validating schema after populating paths');
      console.error(loggingKey, 'validation errors',
          JSON.stringify(apiDocValidation.errors, null, '  '));
      throw new Error(loggingKey +
          'args.apiDoc was invalid after populating paths.  See the output.');
    }
  }

  if (exposeApiDocs) {
    // Swagger UI support
    app.get(basePath + docsPath, function(req, res) {
      res.status(200).json(apiDoc);
    });
  }

  var initializedApi = {
    apiDoc: apiDoc
  };

  return initializedApi;
}

function addOperationTagToApiDoc(apiDoc, tag) {
  if (apiDoc && typeof tag === 'string') {
    var apiDocTags = (apiDoc.tags || []);
    var availableTags = apiDocTags.map(function(tag) {
      return tag && tag.name;
    });

    if (availableTags.indexOf(tag) === -1) {
      apiDocTags.push({
        name: tag
      });
    }

    apiDoc.tags = apiDocTags;
  }
}

function allows(args, prop, val) {
  return ![].slice.call(args).filter(byProperty(prop, val))
    .length;
}

function allowsMiddleware() {
  return allows(arguments, 'x-express-openapi-disable-middleware', true);
}

function allowsCoercionMiddleware() {
  return allows(arguments, 'x-express-openapi-disable-coercion-middleware', true);
}

function allowsDefaultsMiddleware() {
  return allows(arguments, 'x-express-openapi-disable-defaults-middleware', true);
}

function allowsResponseValidationMiddleware() {
  return allows(arguments, 'x-express-openapi-disable-response-validation-middleware',
      true);
}

function allowsValidationMiddleware() {
  return allows(arguments, 'x-express-openapi-disable-validation-middleware', true);
}

function byDefault(param) {
  return param && 'default' in param;
}

function byMethods(name) {
  // not handling $ref at this time.  Please open an issue if you need this.
  return ['get', 'put', 'post', 'delete', 'options', 'head', 'patch']
      .indexOf(name) > -1;
}

function byProperty(property, value) {
  return function(obj) {
    return obj && property in obj && obj[property] === value;
  };
}

function copy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function getAdditionalMiddleware() {
  var additionalMiddleware = [];
  var index = arguments.length - 1;

  while (index > 0) {
    --index;
    var currentDoc = arguments[index + 1];
    var parentDoc = arguments[index];

    if (currentDoc && currentDoc[INHERIT_ADDITIONAL_MIDDLEWARE_PROPERTY] === false) {
      break;
    } else {
      [].unshift.apply(additionalMiddleware, getDocMiddleware(parentDoc));
    }
  }

  return additionalMiddleware.filter(function(middleware) {
    if (typeof middleware === 'function') {
      return true;
    } else {
      console.warn(loggingKey, 'Ignoring ' + middleware + ' as middleware in ' +
          ADDITIONAL_MIDDLEWARE_PROPERTY + ' array.');
      return false;
    }
  });

  function getDocMiddleware(doc) {
    if (doc && Array.isArray(doc[ADDITIONAL_MIDDLEWARE_PROPERTY])) {
      return doc[ADDITIONAL_MIDDLEWARE_PROPERTY];
    }
  }
}

function sortApiDocTags(apiDoc) {
  if (apiDoc && Array.isArray(apiDoc.tags)) {
    apiDoc.tags.sort(function(a, b) {
      return a.name > b.name;
    });
  }
}

function toExpressParams(part) {
  return part.replace(/^\{([^\}]+)\}$/, ':$1');
}

function withNoDuplicates(arr) {
  var parameters = [];
  var seenParams = {};
  var index = arr.length;

  while (index > 0) {
    --index;
    var item = arr[index];
    var key = [item.name, item.location].join(';////|||||\\\\;');

    if (key in seenParams) {
      continue;
    }

    seenParams[key] = true;
    // unshifting to preserve ordering.  I don't believe it matters, but good to be
    // consistent.
    parameters.unshift(item);
  }

  return parameters;
}
