var app = require('express')();
var bodyParser = require('body-parser');
var openapi = require('../../../');
var path = require('path');
var cors = require('cors');

app.use(cors());
app.use(bodyParser.json());

module.exports = async function () {
  await openapi.initialize({
    apiDoc: require('./api-doc.js'),
    app: app,
    paths: path.resolve(__dirname, 'api-routes'),
  });

  app.use(function (err, req, res, next) {
    res.status(err.status).json(err);
  });

  return app;
};

var port = parseInt(process.argv[2], 10);
if (port) {
  app.listen(port);
}
