/*
 * engine.js
 *
 * Defines the Engine object, which is the top level application singleton that represents this running engine instance.
 * 
 * The engine object is primarily defined by its start() method, which defines most of the startup configuration
 * activities for the engine.
 */
var restify = require('restify');
var util = require('./util');
var socketio = require('socket.io');
var async = require('async');
var process = require('process');
var machine = require('./machine');
var detection_daemon = require('./detection_daemon');
var config = require('./config');
var PLATFORM = process.platform;
var log = require('./log').logger('engine');
var db = require('./db');
var macros = require('./macros');
var dashboard = require('./dashboard');
var network = require('./network');
var glob = require('glob');
var argv = require('minimist')(process.argv);
var fs = require('fs');
var sessions = require("client-sessions");
var authentication = require('./authentication');
var profiles = require('./profiles');
var crypto = require('crypto');

// The engine object has a few high level properties and some key methods that define the application lifecycle
// Most of the important stuff is in the start() method.
var Engine = function() {
    this.version = null;
    this.time_synced = false;
    this.firmware = {
        build : null,
        config : null,
        version : null
    }
};

/*
 * Configure the engine for the first time.
 * This function is typically called when an engine configuration does not exist.
 * It sets some defaults in the engine config (by way of the config module) based on system platform.
 * Mainly this amounts to configuring appropriate serial port paths and http hosting ports 
 * for different types of machines.
 */
function EngineConfigFirstTime(callback) {
    switch(PLATFORM) {
        case 'linux':
                    var ports = {
                        'control_port_linux' : '/dev/ttyACM0',
                        'data_port_linux' : '/dev/ttyACM0'
                    }
                    config.engine.update(ports, function() {
                        callback();
                    });
            break;
        case 'darwin':
            config.engine.set('server_port', 9876);
            glob.glob('/dev/cu.usbmodem*', function(err, files) {
                if(files.length >= 1) {
                    var ports = {
                        'control_port_osx' : files[0],
                        'data_port_osx' : files[1] || files[0]
                    }
                    config.engine.update(ports, function() {
                        callback();
                    });
                } else {
                    callback();
                }
            });
        break;

        default:
            callback();
        break;
    }
};

/*
 * Set the current system time to the provided value.
 * obj - an object with a 'utc' property that coresponds to the current UTC time
 */
Engine.prototype.setTime = function(obj) {
    if(!this.time_synced) {
        this.time_synced = true;
        var d = new Date(obj.utc);
        log.debug("Setting the time to " + d.toUTCString());
        var t = d.getUTCFullYear() + '-' + d.getUTCMonth() + '-' + d.getUTCDay() + ' ' + d.getUTCHours() + ':' + d.getUTCMinutes() + ':' + d.getUTCSeconds()
        cmd = 'timedatectl set-time ' + t + '; timedatectl';
        util.doshell(cmd, function(stdout) {
            log.debug(stdout);
        });
    }
}

/*
 * Stop this engine instance.
 * Basically does cleanup activities before shutting the engine down.
 */
Engine.prototype.stop = function(callback) {
    this.machine.disconnect();
    this.machine.setState(this.machine, 'stopped');
    callback(null);
};

/*
 * Get the version of this engine.
 * 
 * For production builds, the version is provided by a version.json that defines a version object that includes:
 * hash - A hash for the build, typically a commit SHA (may not exist in a release type build)
 * number - The semver version number
 * type - The type of release, either 'dev', 'rc', or 'release'
 * 
 * If that file exists and can be parsed, return a version object that reflects its contents.
 * If it does not exist, use git (if available on the system) to read out some version information instead
 */
Engine.prototype.getVersion = function(callback) {
    util.doshell('git rev-parse --verify HEAD', function(data) {
        this.version = {};
        this.version.hash = (data || "").trim();
        this.version.number = "";
        this.version.debug = ('debug' in argv);
    fs.readFile('version.json', 'utf8', function(err, data) {
            if(err) {
                this.version.type = 'dev';
                return callback(null, this.version);
            }
            try {
                data = JSON.parse(data);
                if(data.number) {
                    this.version.number = data.number;
                    this.version.type = 'release';
                }
            } catch(e) {
                this.version.type = 'dev';
            } finally {
                callback(null, this.version);
            }
        }.bind(this))
    }.bind(this));
}

/*
 * Return "info" about this engine, which currently is just version data for the engine and the firmware
 */
Engine.prototype.getInfo = function(callback) {
    callback(null, {
        firmware : this.firmware,
        version : this.version
    });
}

/*
 * This function is the primary content of the Engine object.  It is called on application launch, and is
 * sort of the "main thread" of execution.  It executes a bunch of startup/configuration functions, and 
 * then sets up the http server to listen on the appropriate port.  Setup happens first so the user doesn't
 * connect to the engine before it is ready to accept connections.
 */
Engine.prototype.start = function(callback) {

    async.series([

        // Configure the engine data directories
        // Create the folder structure (typically) in /opt/fabmo
        // eg: /opt/fabmo/config, /opt/fabmo/macros, etc...
       function setup_application(callback) {
            log.info('Checking engine data directory tree...');
            config.createDataDirectories(callback);
        },

        // Load the engine configuration from disk.
        function load_engine_config(callback) {
            log.info("Loading engine configuration...");
            config.configureEngine(callback);
        },

        // Determine if we're configuring the engine for the first time ever.
        // If so, populate the engine configuration with defaults that are sensible for this platform.
        function check_engine_config(callback) {
            if(!config.engine.get('init')) {
                log.info('Configuring the engine for the first time...');
                EngineConfigFirstTime(function() {
                    config.engine.set('init', true);
                    callback();
                });
            } else {
                callback();
            }
        },

        // Load profiles.  See the profiles module for what this entails.
        function load_profiles(callback) {
            profiles.load(function(err, profiles) {
                if(err) {log.error(err);}
                callback()
            });
        },

        // Load users.  See config/user_config.js for what this entails.
        function load_users(callback) {
            log.info('Loading users....')
            config.configureUser(function(){
                callback();
            });
        },

        // Read the selected profile from the engine config.
        // If the engine config doesn't specify a profile, look in /fabmo/site/.default
        // If /fabmo/site/.default exists and has content, interpret its content as the selected profile.
        // If neither of these strategies yields a profile, just choose the 'Default' profile.
        function profile_shim(callback) {
            var profile = config.engine.get('profile');
            var def = '';
            if(profile) { 
                return callback(); 
            } else {
                fs.readFile('../site/.default','utf8', function (err, content) {
                    if(err){
                        def = 'Default';
                    } else {
                        def = content;
                    }
                    config.engine.set('profile', def, callback);
                })
            }
        }.bind(this), 

        // Read the engine version and hang onto it
        function get_fabmo_version(callback) {
            log.info("Getting engine version...");
            this.getVersion(function(err, data) {
                if(err) {
                    log.error(err);
                    this.version = "";
                    return callback();
                }
                log.info("Got engine version: " + JSON.stringify(this.version));
                this.version = data;
                callback();
            }.bind(this));
        }.bind(this),

        // The approot should be cleared if:
        //   - We're running in 'debug' mode (and might be making changes to system apps)
        //   - The version of the engine has changed since the last time we run it.
        // So, we check those things, and clear the approot accordingly.
        //
        // See dashboard/app_manager.js for more about the approot.
        function clear_approot(callback) {
            if('debug' in argv) {
                log.info("Running in debug mode - clearing the approot.");
                
                // If in debug mode, we also set our version to a random number, which provides effective
                // cache-busting on the client side when debugging.
                // TODO: This probably isn't the place for this, it should go up where the other version stuff is.
                var random = Math.floor(Math.random() * (99999 - 10000)) + 10000;
                log.info("Setting engine version to random");
                config.engine.set('version', random.toString());
                
                // Clear the actual approot
                config.clearAppRoot(function(err, stdout) {
                    if(err) { log.error(err); }
                    else {
                        log.debug(stdout);
                    }
                    // TODO - seems like we don't need to do this twice
                    config.engine.set('version', random.toString());
                    callback();
                });
                
            } else {
                var last_time_version = (config.engine.get('version') || '').trim();
                var this_time_version = (this.version.hash || this.version.number || "").trim();
                log.debug("Previous engine version: " + last_time_version);
                log.debug(" Current engine version: " + this_time_version);

                if(last_time_version != this_time_version) {
                    log.info("Engine version has changed - clearing the approot.");
                    // TODO - reduce code by moving this clearAppRoot out of the if else in its own test (Just set a shouldClearApproot flag or something in the if-else)
                    config.clearAppRoot(function(err, stdout) {
                        config.engine.set('version', this_time_version);
                        if(err) { log.error(err); }
                        else {
                            log.debug(stdout);
                        }
                        callback();
                    });
                } else {
                    log.info("Engine version is unchanged since last run.");
                    callback();
                }
                
            }
            
        }.bind(this),

        // TODO - this seems like a duplication of the same step above (see the beginning of this startup sequence)
        function create_data_directories(callback) {
            config.createDataDirectories(callback);
        }.bind(this),

        // "Apply" the engine configuration, that is, take the configuration values loaded and actually
        // set up the application based on them. See config/engine_config.js to see what this entails.
        function apply_engine_config(callback) {
            log.info("Applying engine configuration...");
            config.engine.apply(callback);
        },

        // Configure the DB see db.js to see what this entails.
        function setup_database(callback) {
            log.info("Configuring database...");
            db.configureDB(callback);
        },

        // Cleanup the DB.  This is to clear jobs that may be "dangling" after a crash, or other inconsistencies.
        // See db.js for more details.
        function clean_database(callback) {
            log.info("Cleaning up database...");
            db.cleanup(callback);
        },

        // Connect to G2 and initialize machine runtimes.  See machine.js for what this entails.
        function connect(callback) {
            log.info("Connecting to G2...");
            machine.connect(function(err, machine) {
                if(err) {
                    log.error("!!!!!!!!!!!!!!!!!!!!!!!!");
                    log.error("Could not connect to G2.");
                    log.error("(" + err + ")");
                    log.error("!!!!!!!!!!!!!!!!!!!!!!!!");
                }
                callback(null);
            });
        }.bind(this),

        function launch_detection_daemon(callback){
            log.info("Launching detection daemon...");
            detection_daemon();
            callback(null);
        }.bind(this),

        // Apply the "machine" configuration - see config/machine_config.js for details
        function load_machine_config(callback) {
            this.machine = machine.machine;
            log.info('Loading the machine configuration...')
            config.configureMachine(this.machine, function(err, result) {
                if(err) {
                    log.warn(err);
                }
                callback(null);
            });
        }.bind(this),

        // The default unit system is specified in the machine configuration.  It requires
        // special care to apply - see g2.js for details.
        function set_units(callback) {
            if(this.machine.isConnected()) {
                this.machine.driver.setUnits(config.machine.get('units'), callback);
            } else {
                callback(null);
            }
        }.bind(this),

        // Configure G2 by loading all its json settings and static configuration parameters
        function load_driver_config(callback) {
            if(this.machine.isConnected()) {
                log.info("Configuring G2...");
                config.configureDriver(machine.machine.driver, function(err, data) {
                    if(err) {
                        log.error("There were problems loading the G2 configuration.");
                    }
                    callback(null);
                });
            } else {
                log.warn("Skipping G2 configuration due to no connection.");
                config.configureDriver(null, function(err, data) {
                    callback(null);
                })
                callback(null);
            }
        }.bind(this),

        // Retrieve the firmware version from G2.  This is done only once, and the value
        // is cached as a property of the Engine object.
        function get_g2_version(callback) {
            if(this.machine.isConnected()) {
                log.info("Getting G2 firmware version...");
                this.machine.driver.get(['fb','fbs','fbc'], function(err, value) {
                    if(err) {
                        log.error('Could not get the G2 firmware build. (' + err + ')');
                    } else {
                        log.info('G2 Firmware Information: ' + value);
                        this.firmware.build = value[0];
                        this.firmware.version = value[1];
                        this.firmware.config = value[2];
                    }
                    callback(null);
                }.bind(this));
            } else {
                log.warn("Skipping G2 firmware version check due to no connection.")
                callback(null);
            }
        }.bind(this),

        // This is a shim that clears some obsolete entries from the configuration that have been
        // known to cause errors with modern versions of G2.
        // TODO - this is the sort of thing that might be better done by the updater as part of the 
        //        installation process.  It is typical for such processes to "migrate" config files to latest version.
        function g2_shim(callback) {
          log.debug("Running G2 Shim...");
          var entries = [
            '1sa','1tr','1mi',
            '2sa','2tr','2mi',
            '3sa','3tr','3mi',
            '4sa','4tr','4mi',
            '5sa','5tr','5mi',
            '6sa','6tr','6mi',
            'ja',
            '6ma',
            '6po',
            '6su',
            '6pm',
            '6pl'
          ]
          var do_shim = false;
          for(var i=0; i<entries.length; i++) {
            if(config.driver.has(entries[i])) {
              do_shim = true;
            }
          }
          if(do_shim) {
            log.debug("Deleting obsolete entries in G2 config");
            config.driver.deleteMany(entries, function(err, data) {
              config.driver.restore(function() {
                callback();
              });
            });
          } else {
            log.debug("No obsolete entries in G2 config.");
            callback();
          }
        }.bind(this),

        // Load commands which are populated dynamically from the contents of a folder
        // in the openSBP runtime.  See runtime/opensbp/opensbp.js for what this entails.
        function load_opensbp_commands(callback) {
            if(!this.machine.isConnected()) {
                log.warn('Not loading SBP Commands due to no connection to motion system.')
                return callback(null);
            }
            log.info("Loading OpenSBP Commands...");
            this.machine.sbp_runtime.loadCommands(callback);
        }.bind(this),

        // Apply the OpenSBP runtime config.  See config/opensbp_config.js for what this entails.
        function load_opensbp_config(callback) {
            if(!this.machine.isConnected()) {
                log.warn('Not configuring SBP due to no connection to motion system.')
                return callback(null);
            }
            log.info("Configuring OpenSBP runtime...");
            config.configureOpenSBP(callback);
        }.bind(this),

        // Apply the machine config.  See config/machine_config.js for what this entails
        function apply_machine_config(callback) {
            log.info("Applying machine configuration...");
            config.machine.apply(callback);
        }.bind(this),

        // Setup the dashboard.  See dashboard/index.js and dashboard/app_manager.js for what this entails.
        function configure_dashboard(callback) {
            log.info("Configuring dashboard...");
            dashboard.configure(callback);
        },

        // Load the apps, see dashboard/app_manager.js for what this entails.
        // TODO: Would this be better to just be included in the dashboard configuration function?
        function load_apps(callback) {
            log.info("Loading dashboard apps...");
            dashboard.loadApps(function(err, result) {
                callback(null, result);
            });
        },

        // Load macros from disk.  See macros.js
        function load_macros(callback) {
            log.info("Loading macros...")
            macros.load(callback);
        },

        // Load and apply the 'instance' configuration.  This is the dynamic machine state, like the current position,
        // which is saved periodically in order to preserve state if the tool is power cycled.
        // See config/instance_config.js for more details.
        function load_instance_config(callback) {
            if(!this.machine.isConnected()) {
                log.warn('Not configuring instance due to no connection to motion system.')
                return callback(null);
            }
            log.info("Loading instance info...");
            config.configureInstance(this.machine.driver, callback);
        }.bind(this),

        function apply_instance_config(callback) {
            if(!this.machine.isConnected()) {
                log.warn('Not applying instance config due to no connection to motion system.')
                return callback(null);
            }
            log.info("Applying instance configuration...");
            config.instance.apply(callback);
        }.bind(this),

        // The secret key is used for authentication.  It is persistent, stored with other config files.
        function generate_auth_key(callback) {
          log.info("Configuring secret key...")
          var secret_file = config.getDataDir() + '/config/auth_secret'
          fs.readFile(secret_file, 'utf8', function(err, data) {

            // If there's already a secret key from disk, use it
            if(!err && data && (data.length == 512)) {
              log.info("Secret key already exists, using that.")
              this.auth_secret = data;
              return callback();
            }

            // If not, generate, save and use a new one
            log.info("Generating a new secret key.")
            this.auth_secret = crypto.randomBytes(256).toString('hex');
            fs.writeFile(secret_file, this.auth_secret, function(err, data) {
              callback();
            }.bind(this));

          }.bind(this))
        }.bind(this),

        // Kick off the server if all of the above went OK.
        function start_server(callback) {
            log.info("Setting up the webserver...");

            // TODO: Is this used any longer?  Maybe remove it.
            var fmt = {
                'application/json': function(req, res, body) {
                    return cb(null, JSON.stringify(body, null, '\t'));
                }
            }

            // Initialize a server and attach it to the application
            var server = restify.createServer({name:"FabMo Engine"});
            this.server = server;

            // Allow JSON over Cross-origin resource sharing
            log.info("Configuring cross-origin requests...");
            server.use(
                function crossOrigin(req,res,next){
                    res.header("Access-Control-Allow-Origin", "*");
                    res.header("Access-Control-Allow-Headers", "X-Requested-With");
                    return next();
                }
            );

            // Introduce deliberate latency for testing.  You can activate this by
            // passing the --slow switch when running server.js (must include --debug too)
            if('debug' in argv && argv.debug === 'slow') {
                log.warn("Configuring deliberate latency for testing...")
                server.use(
                    function latency(req, res, next) {
                        setTimeout(next,500*Math.random());
                    }
                );
            }

            // If in 'debug' mode, do some extra logging of HTTP requests
            if('debug' in argv) {
                server.use(
                    function debug(req, res, next) {
                        log.debug(req.method + ' ' + req.url);
                        next();
                    });
            }

            // The query parser does just that - map query params to an object for convenience
            server.use(restify.plugins.queryParser({
                mapParams : true
            }));

            /*
             * The engine URL scheme includes a software version number that performs a 
             * cache-busting function:  When the engine is updated, the version number in the
             * URL is revised, and the cache is thus busted.
             * 404 errors are handled in two different ways depending on their content:
             */
            server.on('NotFound', function (req, res, cb) {
                var current_hash = config.engine.get('version');
                var url_arr = req.url.split('/');
                // If a URL contains a hash that doesn't match the current version hash:
                // Replace the URL's hash with the current one, and redirect.
                if(url_arr[1] !== current_hash){
                    url_arr.splice(1,1, current_hash);
                    var newPath = url_arr.join('/');
                    res.redirect(newPath , function(){
                        return;
                    });
                } else {
                    // If the URL contains a current hash, and simply points to a bogus resource,
                    // just redirect to the root.
                    res.redirect('/' , function(){
                        return;
                    });
                }
            }); 

            // Catch-all handler that responds gracefully when an internal server error occurs.
            server.on('uncaughtException', function(req, res, route, err) {
                log.uncaught(err);
                answer = {
                    status:"error",
                    message:err.message
                };
                res.json(answer)
            });

            // Configure local directory for uploading files
            log.info("Cofiguring upload directory...");
            server.use(restify.plugins.bodyParser({
                'uploadDir':config.engine.get('upload_dir') || '/tmp',
                mapParams: true
            }));

            // TODO: What is this path sanitizer doing?
            server.pre(restify.pre.sanitizePath());

            // Configure authentication
            log.info("Cofiguring authentication...");
            log.info("Secret Key: " + this.auth_secret.slice(0,5) + '...' + this.auth_secret.slice(-5));
            server.cookieSecret = this.auth_secret;
            server.use(sessions({
                // cookie name dictates the key name added to the request object
                cookieName: 'session',
                // should be a large unguessable string
                secret: server.cookieSecret, // REQUIRE HTTPS SUPPORT !!!
                // how long the session will stay valid in ms
                cookie: {
                  //: '/api', // cookie will only be sent to requests under '/api'
                  maxAge: (31 * 24 * 60 * 60 * 1000),  // duration of the cookie in milliseconds, defaults to duration above
                  ephemeral: false, 
                  httpOnly: false, // when true, cookie is not accessible from javascript
                  secure: false // when true, cookie will only be sent over SSL. use key 'secureProxy' instead if you handle SSL not in your node process
                }
            }));
            server.use(authentication.passport.initialize());
            server.use(authentication.passport.session());


            // gzipping is a typical way to speed up network operations
            // We enable it on the server, so that supporting clients can use it
            log.info("Enabling gzip for transport...");
            server.use(restify.plugins.gzipResponse());


            // Import the routes module and apply the routes to the server
            // Routes are loaded dynamically. See routes/routes.js for details.
            log.info("Loading routes...");
            server.io = socketio.listen(server.server);
            var routes = require('./routes')(server);

            // Kick off the server listening for connections
            // 0.0.0.0 causes us to listen on ALL interfaces (so the engine can be seen over ethernet, wifi, etc.)
            server.listen(config.engine.get('server_port'), "0.0.0.0", function() {
                log.info(server.name+ ' listening at '+ server.url);
                callback(null, server);
            });

            // TODO - should this be done after server.listen, or before? (or does it matter?)
            authentication.configure();

        }.bind(this),
        ],
        // Print some kind of sane debugging information if anything above fails
        function(err, results) {
            if(err) {
                log.stack();
                log.error(err);
                typeof callback === 'function' && callback(err);
            } else {
                typeof callback === 'function' && callback(null, this);
            }
        }.bind(this)
    );
};

// This module IS the engine object, but instantiating the object does virtually nothing:
// It is the call to start() that kicks off all the real work of running the application.
module.exports = new Engine();
