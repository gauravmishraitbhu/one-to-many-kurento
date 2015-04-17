var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var ws = require('ws');
var minimist = require('minimist');
var url = require('url');
var kurento = require('kurento-client');

var routes = require('./routes/index');
var users = require('./routes/users');

var app = express();

//view engine setup
//app.use(express.static(path.join(__dirname, 'static')));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

//uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', routes);
app.use('/users', users);

//catch 404 and forward to error handler
app.use(function(req, res, next) {
	var err = new Error('Not Found');
	err.status = 404;
	next(err);
});

//error handlers

//development error handler
//will print stacktrace
if (app.get('env') === 'development') {
	app.use(function(err, req, res, next) {
		res.status(err.status || 500);
		res.render('error', {
			message: err.message,
			error: err
		});
	});
}

//production error handler
//no stacktraces leaked to user
app.use(function(err, req, res, next) {
	res.status(err.status || 500);
	res.render('error', {
		message: err.message,
		error: {}
	});
});



var argv =	{
				as_uri: "http://localhost:8080/",
				ws_uri: "ws://192.168.0.110:8888/kurento"
			};


/*
 * Definition of global variables.
 */

var idCounter = 0;
var master = null;
var pipeline = null;
var viewers = {};
var kurentoClient = null;

function nextUniqueId() {
	idCounter++;
	return idCounter.toString();
}

/*
 * Server startup
 */

var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;

var server = app.listen(port, function() {
	console.log('Kurento Tutorial started');
	console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
	server : server,
	path : '/call'
});

/*
 * Definition of functions
 */

function stop(id, ws) {
	if (master !== null && master.id === id) {
		for ( var ix in viewers) {
			var viewer = viewers[ix];
			if (viewer.ws) {
				viewer.ws.send(JSON.stringify({
					id : 'stopCommunication'
				}));
			}
		}
		viewers = {};
		pipeline.release();
		pipeline = null;
		master = null;
	} else if (viewers[id]) {
		var viewer = viewers[id];
		if (viewer.webRtcEndpoint){
			viewer.webRtcEndpoint.release();
		}
			
		delete viewers[id];
	}
}

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
	if (kurentoClient !== null) {
		return callback(null, kurentoClient);
	}

	kurento(argv.ws_uri, function(error, _kurentoClient) {
		if (error) {
			console.log("Coult not find media server at address " + argv.ws_uri);
			return callback("Could not find media server at address" + argv.ws_uri +
					 ". Exiting with error " + error);
		}

		kurentoClient = _kurentoClient;
		callback(null, kurentoClient);
	});
}

function startMaster(id, sdp, callback) {
	if (master !== null) {
		return callback("Another user is currently acting as sender. Try again later ...");
	}

	master = {
		id : id,
		webRtcEndpoint : null
	};

	if (pipeline !== null) {
		stop(id);
	}

	getKurentoClient(function(error, kurentoClient) {
		if (error) {
			stop(id);
			return callback(error);
		}

		if (master === null) {
			return callback('Request was cancelled by the user. You will not be sending any longer');
		}

		kurentoClient.create('MediaPipeline', function(error, _pipeline) {
			if (error) {
				return callback(error);
			}

			if (master === null) {
				return callback('Request was cancelled by the user. You will not be sending any longer');
			}

			pipeline = _pipeline;
			pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
				if (error) {
					stop(id);
					return callback(error);
				}

				if (master === null) {
					return callback('Request was cancelled by the user. You will not be sending any longer');
				}

				master.webRtcEndpoint = webRtcEndpoint;

				webRtcEndpoint.processOffer(sdp, function(error, sdpAnswer) {
					if (error) {
						stop(id);
						return callback(error);
					}

					if (master === null) {
						return callback('Request was cancelled by the user. You will not be sending any longer');
					}

					callback( null, sdpAnswer);
				});
			});
		});
	});
}

function startViewer(id, sdp, ws, callback) {
	if (master === null || master.webRtcEndpoint === null) {
		return callback("No active sender now. Become sender or . Try again later ...");
	}

	if (viewers[id]) {
		return callback("You are already viewing in this session. Use a different browser to add additional viewers.");
	}

	pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
		if (error) {
			return callback(error);
		}

		var viewer = {
			id : id,
			ws : ws,
			webRtcEndpoint : webRtcEndpoint
		};
		viewers[viewer.id] = viewer;

		if (master === null) {
			stop(id);
			return callback("No active sender now. Become sender or . Try again later ...");
		}

		webRtcEndpoint.processOffer(sdp, function(error, sdpAnswer) {
			if (error) {
				stop(id);
				return callback(error);
			}

			if (master === null) {
				stop(id);
				return callback("No active sender now. Become sender or . Try again later ...");
			}

			master.webRtcEndpoint.connect(webRtcEndpoint, function(error) {
				if (error) {
					stop(id);
					return callback(error);
				}

				if (master === null) {
					stop(id);
					return callback("No active sender now. Become sender or . Try again later ...");
				}

				return callback(null, sdpAnswer);
			});
		});
	});
}





/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {

	var sessionId = nextUniqueId();

	console.log('Connection received with sessionId ' + sessionId);

	ws.on('error', function(error) {
		console.log('Connection ' + sessionId + ' error');
		stop(sessionId);
	});

	ws.on('close', function() {
		console.log('Connection ' + sessionId + ' closed');
		stop(sessionId);
	});

	ws.on('message', function(_message) {
		var message = JSON.parse(_message);
		console.log('Connection ' + sessionId + ' received message ', message);

		switch (message.id) {
		case 'master':
			startMaster(sessionId, message.sdpOffer,
				function(error, sdpAnswer) {
					if (error) {
						return ws.send(JSON.stringify({
							id : 'masterResponse',
							response : 'rejected',
							message : error
						}));
					}
					ws.send(JSON.stringify({
						id : 'masterResponse',
						response : 'accepted',
						sdpAnswer : sdpAnswer
					}));
				});
			break;

		case 'viewer':
			startViewer(sessionId, message.sdpOffer, ws, function(error,
					sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'viewerResponse',
						response : 'rejected',
						message : error
					}));
				}

				ws.send(JSON.stringify({
					id : 'viewerResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;

		case 'stop':
			stop(sessionId);
			break;

		default:
			ws.send(JSON.stringify({
				id : 'error',
				message : 'Invalid message ' + message
			}));
			break;
		}
	});
});




module.exports = app;
