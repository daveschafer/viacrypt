/*
 * Copyright (c) 2013, Vialink Informática. All rights reserved.
 *
 * This file is part of ViaCRYPT.
 *
 * ViaCRYPT is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * ViaCRYPT is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with ViaCRYPT.  If not, see <http://www.gnu.org/licenses/>.
 */

// The web server
// ==============

var connect = require('connect'),
	express = require('express'),
	uuid = require('node-uuid'),
	version = require('../package').version,
	i18n = require('./i18n'),
	Message = require('./message').Message;

var re_uuid = /^[A-Za-z0-9-]+$/;
var re_userdata = /^[A-Za-z0-9+/=]+$/;

// Initial configuration
// ---------------------

var Server = function(config) {
	this.config = config;

	// set up 
	var Provider = require('./providers/' + config.provider.type).Provider;
	var provider = this.provider = new Provider(config);
	var message = this.message = new Message(config);

	this.app = express();

	// ### set up hooks
	var hooks = [];
	if (config.notifications) {
		var Mailer = require('./mailer').Mailer;
		var mailer = new Mailer(config);
		hooks.push(function(data) {
			if (data.email) {
				mailer.send_mail(data);
			}
		});
	}

	// parses the message removing the email address header 
	// if necessary and verifying if an email has to be sent
	function prepare(data) {
		var clone = JSON.parse(JSON.stringify(data));
		if (config.notifications.hide_header !== false) {
			delete clone.email;
		}
		return message.compile(clone);
	}

	// ### set up middlewares
	var middleware = [];
	if (config.ratelimit) {
		var Ratelimit = require('./ratelimit').Ratelimit;
		var ratelimit = new Ratelimit(config);
		middleware.push(ratelimit.rate_middleware);
	}

	// ### getting a message
	//
	// return message and delete it
	this.app.get('/m/:id', function(req, res) {
		var id = req.params.id;
		res.header('Cache-Control', 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0');
		if (re_uuid.test(id) === false) {
			res.statusCode = 404;
			res.send('invalid id');
		} else {
			provider.get(id, function(err, data) {
				if (err) {
					res.statusCode = 404;
					res.send('id not found');
				} else {
					res.send(prepare(data));
					hooks.forEach(function(hook) { hook(data); });
				}
			});
		}
	});

	// ### storing a messsage
	//
	this.app.post('/m/', middleware, function(req, res) {
		var userdata = req.body.data;
		if (re_userdata.test(userdata) === false) {
			res.statusCode = 400;
			res.send('invalid data');
			return;
		}
		var ip = req.get('X-Forwarded-For');
		if (ip === undefined) {
			ip = req.connection.remoteAddress;
		} else {
			ip += ' (via ' + req.connection.remoteAddress + ')';
		}
		var message = {
			version: version,
			ip: ip,
			date: new Date(),
			notification: req.body.notify,
			locale: i18n.message_locale(req),
			email: req.body.email,
			label: req.body.label,
			data: userdata.match(/.{1,64}/g).join('\n')
		};
		// in theory it's almost impossible to get ONE collision
		// but we're trying 10 times just in case
		var attempts = 0, max_attempts = 10;
		(function save() {
			var id = uuid.v4();
			provider.put(id, message, function(err) {
				if (err) {
					if (err === 'duplicate' && attempts < max_attempts) {
						attempts += 1;
						// recursion! limited to 10 times.
						save();
					} else {
						res.statusCode = 500;
						res.send('something wrong happened: ' + err);
					}
				} else {
					res.send(JSON.stringify({ id: id }));
				}
			});
		})();
	});
};

// return a runnable
Server.prototype.spawn = function() {
	var log_fmt = ':remote-addr :req[X-Forwarded-For] - - [:date] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"';

	var server = connect()
		.use(connect.logger(log_fmt))
		.use(connect.responseTime());

	if (this.config.serve_static === true) {
		server = server
			.use(i18n.localized_static(connect, this.config.static_dir, {maxAge: 10000}))
			.use(connect.static(this.config.assets_dir, {maxAge: 10000}));
	}

	server = server
		.use(connect.limit('10mb'))
		.use(connect.bodyParser())
		.use(this.app);

	var addr = this.config.http.listen;
	var port = this.config.http.port;
	server.run = function() {
		console.log('Server running at ' + addr + ':' + port);
		return this.listen(port, addr);
	};

	return server;
};

module.exports.Server = Server;
