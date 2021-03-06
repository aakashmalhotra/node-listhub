/**
 * Created by arpyvanyan on 9/4/14.
 */


var   _            = require('lodash')
    , fs            = require('fs')
    , lockFile       = require('lockfile')
    , log           = require('debug')('ListHub')
    , request       = require('request')
    ;

// some default values as class constants

ListHub.DATA_FILE_NAME = "data.json";
ListHub.DEFAULT_FILE_EXT = ".xml.gz";
ListHub.DEFAULT_REPORT_FILE = "report.xml";
ListHub.DEFAULT_TMP_DIR = __dirname + "/../.tmp";
ListHub.DEFAULT_DATA_JSON = {
    feedLastModifiedDate: 0
};
ListHub.PICKUP_URL = "https://feeds.listhub.com/pickup/";
ListHub.LOCK_FILE = __dirname + "/../process.lock";

/**
 * Create and setup ListHub object which collects, stores and manages the corresponding channel's feed.
 * @param options {ListHub.options}
 *
 * @returns {ListHub}
 * @constructor
 *
 * @since 0.0.1
 */
function ListHub (options) {

    if (!(this instanceof ListHub)) {
        return new ListHub(options);
    }

    if(_.isUndefined(options.username) || _.isUndefined(options.password)) {
        throw new Error(ErrorMessages.missingUsernameOrPassword);
    }

    if(_.isUndefined(options.channelId)) {
        throw new Error(ErrorMessages.missingChannelId);
    }

    //set up class statics depending on provided constructor options

    var self = this;
    lockFile.check(ListHub.LOCK_FILE, {}, function (err, isLocked) {
        if(err) {
            throw err;
        }

        if(isLocked) {
            lockFile.unlock(ListHub.LOCK_FILE, function (error) {
                self.init(options);
            });
        } else {
            self.init(options);
        }
    });
}

/**
 * ListHub class prototype override with methods
 * @type {{init: Function, checkAndGetNewFile: Function, clearFeedFiles: Function, getSingleListingJson: Function, getXml: Function, getXmlString: Function, _checkFeedUpdate: Function, _saveNewFeedFiles: Function, _saveUncompressedFeed: Function, _getLastFetchData: Function, _getLastFetchedDate: Function, _setLastFetchedDate: Function, _renameFeedFilesHandler: Function, _renameErrorFileHandler: Function}}
 */
ListHub.prototype = {

    /**
     * Initialize class with defaults and options
     * @param options {ListHub.options}
     * @return {null}
     *
     * @since 0.0.8
     */
    init: function (options) {
        this.account = {username: options.username, password: options.password};
        this.channelId = options.channelId;
        this.cronJobs = [];
        this.onCronComplete = !_.isUndefined(options.onCronComplete) ? options.onCronComplete : null;
        this.runAt = !_.isUndefined(options.runAt) ? options.runAt : null;
        this.runCronAtOnce = !_.isUndefined(options.runCronAtOnce) ? options.runCronAtOnce : false;
        this.saveAsJson = options.saveAsJson;
        this.setCron = !_.isUndefined(options.setCron) ? options.setCron : false;
        this.tmpDir = !_.isUndefined(options.tmpDirectory) ? options.tmpDirectory : ListHub.DEFAULT_TMP_DIR;

        if(!_.isUndefined(options.filename)) {
            this.gzFilename = options.gzFilename + ListHub.DEFAULT_FILE_EXT;
            this.jsonFilename = options.gzFilename + ".json";
            this.xmlFilename = options.gzFilename + ".xml";
        } else {
            this.gzFilename = this.channelId + ListHub.DEFAULT_FILE_EXT;
            this.jsonFilename = this.channelId + ".json";
            this.xmlFilename = this.channelId + ".xml";
        }

        this.url = ListHub.PICKUP_URL + this.channelId + "/" + this.gzFilename;
        this.channelFilesDir = this.tmpDir + "/" + this.channelId;
        this.dataFile = this.channelFilesDir + "/" + ListHub.DATA_FILE_NAME;
        this.gzFeedFile = this.channelFilesDir + "/" + this.gzFilename;
        this.xmlFeedFile = this.channelFilesDir + "/" + this.xmlFilename;
        this.jsonFeedFile = this.channelFilesDir + "/" + this.jsonFilename;
        this.errorFile = this.channelFilesDir + "/error.txt";

        this.reportFile = !_.isUndefined(options.reportFile) ? (options.reportFile == true ? this.channelFilesDir + "/" + ListHub.DEFAULT_REPORT_FILE : options.reportFile) : this.channelFilesDir + "/" + ListHub.DEFAULT_REPORT_FILE;
        this.reportTmpFile = this.reportFile ? this.channelFilesDir + "/tmp_report.txt" : false;

        //create initial tmp file with channel fetch data
        if(!fs.existsSync(this.dataFile)) {
            try {
                var mkpath = require('mkpath');
                mkpath.sync(this.channelFilesDir);
                mkpath = null;
                fs.writeFileSync(this.dataFile, JSON.stringify(ListHub.DEFAULT_DATA_JSON, null, 4));
            } catch (e) {
                log(e.message);
                return null;
            }
        }

        //create empty reports file if it does not exist
        if(this.reportFile) {
            if(!fs.existsSync(this.reportFile)) {
                fs.writeFileSync(this.reportFile, '');
            }

            if(!fs.existsSync(this.reportTmpFile)) {
                fs.writeFileSync(this.reportTmpFile, '[');
            }
        }

        //set up cron to check for new file on specified times
        var self = this;

        if(self.setCron || self.runAt) {
            var cron = require('cron');
            if(self.runAt) {
                if(_.isString(self.runAt)) {
                    try {
                        var checkFileJob = new cron.CronJob(self.runAt, self.checkAndGetNewFile, self.onCronComplete);
                        checkFileJob.start();
                        self.cronJobs.push(checkFileJob);
                    } catch(err) {
                        log(ErrorMessages.cronPatternIsInvalid);
                    }
                }
                if(_.isArray(self.runAt)) {
                    _.forEach(self.runAt, function(runAt) {
                        if(!_.isString(runAt)) {
                            log(ErrorMessages.cronPatternIsInvalid);
                        } else {
                            try {
                                var checkFileJob = new cron.CronJob(runAt, self.checkAndGetNewFile, self.onCronComplete);
                                checkFileJob.start();
                                self.cronJobs.push(checkFileJob);
                            } catch(err) {
                                log(ErrorMessages.cronPatternIsInvalid);
                            }
                        }
                    });
                }
            } else {
                var checkFileJob = new cron.CronJob('00 00 00 * * *', self.checkAndGetNewFile, self.onCronComplete);
                checkFileJob.start();
                self.cronJobs.push(checkFileJob);
            }
        }

        if(self.runCronAtOnce) {
            self.checkAndGetNewFile(self.onCronComplete);
        }
    },

    /**
     * Check if the feed file was updated for the channel. If so, download and save it.
     * @function
     * @param cb {Function}
     *
     * @since 0.0.1
     */
    checkAndGetNewFile: function (cb) {
        var self = this;


        lockFile.check(ListHub.LOCK_FILE, {}, function (err, isLocked) {
            if(err) {
                if(_.isFunction(cb)) {
                    return cb(err);
                } else {
                    return;
                }
            }

            if(isLocked) {
                if(_.isFunction(cb)) {
                    return cb();
                } else {
                    return;
                }
            }

            lockFile.lock(ListHub.LOCK_FILE, {}, function (err) {
                if(err) {
                    lockFile.unlock(ListHub.LOCK_FILE, function (error) {
                        if(error) {
                            if(_.isFunction(cb)) {
                                return cb(error);
                            } else {
                                return;
                            }
                        }
                        if(_.isFunction(cb)) {
                            return cb(err);
                        } else {
                            return;
                        }
                    });
                    return;
                }

                self._checkFeedUpdate(function(err, isUpdated) {
                    if(err) {
                        lockFile.unlock(ListHub.LOCK_FILE, function (error) {
                            if(error) {
                                if(_.isFunction(cb)) {
                                    return cb(error);
                                } else {
                                    return;
                                }
                            }
                            if(_.isFunction(cb)) {
                                return cb(err);
                            } else {
                                return;
                            }
                        });
                        return;
                    }

                    if(!isUpdated) {
                        log('feed file is up to date');
                        lockFile.unlock(ListHub.LOCK_FILE, function (error) {
                            if(error) {
                                if(_.isFunction(cb)) {
                                    return cb(error);
                                } else {
                                    return;
                                }
                            }
                            if(_.isFunction(cb)) {
                                return cb();
                            } else {
                                return;
                            }
                        });
                        return;
                    }

                    //if feed file was updated, then download and save it
                    self._saveNewFeedFiles(function(err) {
                        if(err) {
                            lockFile.unlock(ListHub.LOCK_FILE, function (error) {
                                if(error) {
                                    if(_.isFunction(cb)) {
                                        return cb(error);
                                    } else {
                                        return;
                                    }
                                }
                                if(_.isFunction(cb)) {
                                    return cb(err);
                                } else {
                                    return;
                                }
                            });
                            return;
                        }

                        lockFile.unlock(ListHub.LOCK_FILE, function (err) {
                            if(err) {
                                if(_.isFunction(cb)) {
                                    return cb(err);
                                } else {
                                    return;
                                }
                            }
                            if(_.isFunction(cb)) {
                                return cb();
                            } else {
                                return;
                            }
                        });

                    });
                });
            })
        });
    },

    /**
     * clear all downloaded filed for the channel (gz, xml, json)
     * @function
     * @param cb {Function}
     *
     * @since 0.0.1
     */
    clearFeedFiles: function (cb) {
        var self = this;
        fs.unlink(self.gzFeedFile, function(err) {
            if(err) {
                log(ErrorMessages.failedToRemoveFeedFiles);
                return cb(err);
            }

            fs.unlink(self.xmlFeedFile, function(err) {
                if(err) {
                    log(ErrorMessages.failedToRemoveFeedFiles);
                    return cb(err);
                }

                if(self.saveAsJson) {
                    fs.unlink(self.jsonFeedFile, function(err) {
                        if(err) {
                            log(ErrorMessages.failedToRemoveFeedFiles);
                            return cb(err);
                        }

                        return cb();
                    })
                } else {
                    return cb();
                }
            })
        })
    },

    /**
     * Get json representation of single Listing
     * @param listingXml {Element}
     * @param cb
     * @returns {json}
     *
     * @since v0.0.3
     */
    getSingleListingJson: function(listingXml, cb) {
        var Element = require('libxmljs/lib/element');

        if(!(listingXml instanceof Element)) {
            return cb(new TypeError(ErrorMessages.propertyMustBeInstanceOfLibxmjsElement));
        }

        if(listingXml.name() != 'Listing') {
            return cb(new Error(ErrorMessages.propertyIsNotSingleListing));
        }

        var parseString = require('xml2js').parseString;

        parseString(listingXml, function (err, result) {
            Element = null;
            parseString = null;

            if(err) {
                log(err);
                return cb(err);
            }

            return cb(null, result);
        });
    },

    /**
     * get latest feed as xmlDoc object
     * @returns {Document}
     *
     * @since 0.0.2
     */
    getXml: function() {
        var self = this;

        try{
            var data = fs.readFileSync(self.xmlFeedFile);
            log("read xml file");

            var libxmljs = require("libxmljs");
            var xmlDoc = libxmljs.parseXmlString(data, { noblanks: true });
            data = null;
            libxmljs = null;
            self = null;
            return xmlDoc;
        } catch (err) {
            log(err);
            return null;
        }
    },

    /**
     * get latest feed as xml string
     * @returns {string}
     *
     * @since 0.0.1
     */
    getXmlString: function() {
        var self = this;

        if(!fs.existsSync(self.xmlFeedFile)) {
            return '';
        }

        fs.readFile(self.xmlFeedFile, function(err, data) {
            if(err) {
                log(err);
                return '';
            }

            return data;
        });
    },

    /**
     * Add import status for lingle listing to report file
     * @param listingKey
     * @param status
     * @param url
     * @param message
     * @param timestamp
     * @param cb
     *
     * @since 1.0.0
     */
    addStatusReportForListing: function(listingKey, status, url, message, timestamp, cb) {
        var self = this;

        if(!self.reportFile) {
            return cb(new Error(ErrorMessages.reportingNotSetUp));
        }

        if(_.isUndefined(listingKey) || _.isUndefined(status) || _.isUndefined(url) || _.isUndefined(message) || _.isUndefined(timestamp)) {
            return cb(new Error(ErrorMessages.wrongParams));
        }

        /**
         *
         * @type {{"listing-key": *, status: *, url: *, message: *, timestamp: *}}
         */
        var listingStatusReport = {
            'listing-key':   listingKey,
            'status':        status,
            'url':           url,
            'message':       message,
            'timestamp':     timestamp
        };

        fs.appendFile(self.reportTmpFile, JSON.stringify(listingStatusReport) + ',', cb);
    },

    /**
     * Generates final xml of feed import reports.
     * @param cb
     */
    generateReportFile: function(cb) {
        var self = this;

        //read temp report data
        fs.readFile(self.reportTmpFile, {encoding: 'utf8'}, function (err, data) {
            if (err) {
                return cb(err);
            }

            data = data.substring(0, data.length - 1);
            data += ']';

            data = JSON.parse(data);


            //convert json to xml
            var libxmljs = require("libxmljs");

            var doc = new libxmljs.Document();
            var parent = doc.node('listing-status').node('listings');

            _.forEach(data, function(singleListing) {
                parent =  parent
                                .node('listing')
                                .node('listing-key', singleListing['listing-key'])
                                .parent()
                                .node('status', singleListing.status)
                                .parent()
                                .node('url', singleListing.url)
                                .parent()
                                .node('message', singleListing.message)
                                .parent()
                                .node('timestamp', singleListing.timestamp)
                                .parent()
                                .parent();
            });

            libxmljs = null;
            //save report file
            fs.writeFile(self.reportFile, doc.toString(), function(err) {
                if (err) {
                    return cb(err);
                }

                doc = null;
                //clear temp report file
                fs.writeFile(self.reportTmpFile, '[', function(err) {
                    if (err) {
                        return cb(err);
                    }
                    return cb();
                });
            });
        });
    },

    /**
     * check for new file via HEAD request.
     * @param cb
     * @private
     *
     * @since 0.0.1
     */
    _checkFeedUpdate: function(cb) {
        var self = this;

        request.head(self.url, {auth: {user: self.account.username, pass: self.account.password}}, function(err, res, body) {
            if(err) {
                log(ErrorMessages.headRequestErrorOccurred + res.statusCode);
                return cb(err)
            }

            if(res.statusCode == 200) {
                //check last update date

                var lastFetchedDate = self._getLastFetchedDate();
                var lastModifiedDate = res.headers['last-modified'];

                lastModifiedDate = new Date(lastModifiedDate).getTime();

                if(lastFetchedDate < lastModifiedDate) {
                    return cb(null, true);
                }
            }

            return cb(null, false);
        })
    },

    /**
     * download and save latest feed xml.gz file.
     * Also extracts and saves xml separately.
     * @param cb
     * @private
     *
     * @since 0.0.1
     */
    _saveNewFeedFiles: function (cb) {
        var self = this;

        var tmpFile = this.channelFilesDir + "/tmp_" + Date.now(),
            writeStream = fs.createWriteStream(tmpFile);
        var lastModifiedDate = 0,
            isErrorResponse = false;

        request.get(self.url, {auth: {user: self.account.username, pass: self.account.password}})
            .on("response", function (res) {
                if(res.statusCode == 200 && res.headers['content-type'] == 'application/x-gzip') {
                    lastModifiedDate = res.headers['last-modified'];
                    lastModifiedDate = new Date(lastModifiedDate).getTime();
                } else {
                    isErrorResponse = true;
                }
            })
            .pipe(writeStream);

        writeStream.on("error", function (err) {
            return cb(err);
        });

        writeStream.on("finish", function (err) {
            if(err) {
                return cb(err);
            }

            if(isErrorResponse) {
                log(ErrorMessages.listHubError);

                if(fs.existsSync(self.errorFile)) {
                    fs.unlink(self.errorFile, function (err) {
                        if(err) {
                            return cb(err);
                        }

                        return self._renameErrorFileHandler(tmpFile, cb);
                    })
                } else {
                    return self._renameErrorFileHandler(tmpFile, cb);
                }
            } else {
                if(fs.existsSync(self.gzFeedFile)) {
                    fs.unlink(self.gzFeedFile, function (err) {
                        if(err) {
                            return cb(err);
                        }

                        return self._renameFeedFilesHandler(tmpFile, lastModifiedDate, cb);
                    })
                } else {
                    return self._renameFeedFilesHandler(tmpFile, lastModifiedDate, cb);
                }
            }
        });
    },

    /**
     * unpack downloaded zip file to xml
     * @param cb
     * @private
     *
     * @since 0.0.1
     */
    _saveUncompressedFeed: function (cb) {
        var self = this;

        var readStream = fs.createReadStream(self.gzFeedFile);
        var tmpFile = self.channelFilesDir + "/tmp_xml_" + Date.now() + ".xml";
        var writeStream = fs.createWriteStream(tmpFile);

        var zlib = require('zlib');

        readStream.pipe(zlib.createGunzip()).pipe(writeStream);

        readStream.on("error", function(err) {
            log(err);
            return cb(err);
        });

        writeStream.on("error", function(err) {
            log(err);
            return cb(err);
        });

        writeStream.on("finish", function(err) {
            log("finished unzip");

            zlib = null;
            if(fs.existsSync(self.xmlFeedFile)) {
                fs.unlink(self.xmlFeedFile, function (err) {
                    if(err) {
                        return cb(err);
                    }

                    fs.rename(tmpFile, self.xmlFeedFile, function (err) {
                        if(err) {
                            return cb(err);
                        }

                        return cb(null)
                    })
                })
            } else {
                fs.rename(tmpFile, self.xmlFeedFile, function (err) {
                    if(err) {
                        return cb(err);
                    }

                    return cb(null)
                })
            }
        });
    },

    /**
     * get the timestamp of latest saved feed file
     * @returns {*}
     * @private
     *
     * @since 0.0.1
     */
    _getLastFetchData: function () {
        var self = this;

        try {
            var data = fs.readFileSync(self.dataFile, "utf8");
            data = JSON.parse(data);
            if(!data) {
                return ListHub.DEFAULT_DATA_JSON;
            }
            return data;
        } catch (err) {
            log(err);
            return ListHub.DEFAULT_DATA_JSON;
        }
    },

    /**
     * get the date of last updated feed
     * @returns {number}
     * @private
     *
     * @since 0.0.1
     */
    _getLastFetchedDate: function () {
        var self = this;
        return self._getLastFetchData().feedLastModifiedDate;
    },

    /**
     * update the last fetched file's modified date in data
     * @param newDate
     * @returns {boolean}
     * @private
     *
     * @since 0.0.1
     */
    _setLastFetchedDate: function (newDate) {
        var self = this;

        var currentData = self._getLastFetchData();
        currentData.feedLastModifiedDate = newDate;

        try {
            fs.writeFileSync(self.dataFile, JSON.stringify(currentData, null, 4));
        } catch (err) {
            log(err);
            return false;
        }
        return true;
    },

    /**
     * rename tmp feed file handler
     * @param tmpFile
     * @param lastModifiedDate
     * @param cb
     * @private
     *
     * @since 0.0.1
     */
    _renameFeedFilesHandler: function (tmpFile, lastModifiedDate, cb) {
        var self = this;

        fs.rename(tmpFile, self.gzFeedFile, function (err) {
            if(err) {
                return cb(err);
            }

            self._saveUncompressedFeed(function(err) {
                if(err) {
                    return cb(err);
                }

                //update last modified date in data file

                if(lastModifiedDate) {
                    self._setLastFetchedDate(lastModifiedDate);
                }

                return cb();
            });
        })
    },

    /**
     * rename tmp feed error file handler
     * @param tmpFile
     * @param cb
     * @private
     *
     * @since 0.0.8-rc3
     */
    _renameErrorFileHandler: function (tmpFile, cb) {
        var self = this;

        fs.rename(tmpFile, self.errorFile, function (err) {
            if(err) {
                return cb(err);
            }
            return cb();
        })
    }
};


/**
 * @typedef ListHub.options
 */
ListHub.options = {
    /**
     * @type {String | undefined}
     * @default undefined
     */
    channelId: undefined,
    /**
     * @type {String | undefined}
     * @default undefined
     */
    username: undefined,
    /**
     * @type {String | undefined}
     * @default undefined
     */
    password: undefined,
    /**
     * @type {String | undefined}
     * @default undefined
     */
    saveAsJson: undefined,
    /**
     * @type {String | undefined}
     * @default undefined
     */
    filename: undefined,
    /**
     * @type {String | undefined}
     * @default undefined
     */
    runAt: undefined,
    /**
     * @type {Boolean}
     * @default false
     */
    setCron: false,
    /**
     * @type {Boolean}
     * @default false
     */
    runCronAtOnce: false,
    /**
     * @type {String | undefined}
     * @default undefined
     */
    onCronComplete: undefined,
    /**
     * @type {String | undefined}
     * @default undefined
     */
    tmpDirectory: undefined,
    /**
     * @type {String | Boolean}
     * @default undefined
     */
    reportFile: false
};

module.exports = ListHub;