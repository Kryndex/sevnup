module.exports = Sevnup;

var _ = require('lodash');
var farmhash = require('farmhash');
var async = require('async');
var CacheStore = require('./cache_store');

var DEFAULT_TOTAL_VNODES = 1024;
var DEFAULT_CALM_THRESHOLD = 500;
var MAX_PARALLEL_TASKS = 10;

/**
 * Params are:
 *   hashRing
 *   store
 *   recoverKey
 *   releaseKey
 *   totalVNodes
 *   logger
 */
function Sevnup(params) {
    this.hashRing = params.hashRing;
    this.hashRingLookup = this.hashRing.lookup.bind(this.hashRing);
    this.store = new CacheStore(params.store);
    this.recoverKeyCallback = params.recoverKey;
    this.releaseKeyCallback = params.releaseKey;
    this.totalVNodes = params.totalVNodes || DEFAULT_TOTAL_VNODES;
    this.logger = params.logger;
    this.calmThreshold = params.calmThreshold || DEFAULT_CALM_THRESHOLD;
    this.calmTimeout = null;

    this.ownedVNodes = [];

    this._attachToRing();
}

Sevnup.prototype._attachToRing = function _attachToRing() {
    var self = this;

    this.hashRing.lookup = function sevnupLookup(key) {
        var vnode = self._getVNodeForKey(key);
        var node = self.hashRingLookup(vnode);
        if (self.hashRing.whoami() === node) {
            self.store.addKey(vnode, key, function(err) {
                if (err) {
                    self.logger.error("Sevnup.sevnupLookup failed to persist key", {
                        vnode: vnode,
                        key: key,
                        error: err
                    });
                }
            });
        }
        return node;
    };

    if (this.hashRing.isReady) {
        onReady();
    } else {
        this.hashRing.on('ready', onReady);
    }

    function onReady() {
        self.hashRing.on('changed', self._onRingStateChange.bind(self));
        self._onRingStateChange();
    }
};

/**
 * Returns true if this node currently owns vnode.
 * @param {string} vnodeName The name of the vnode to check.
 */
Sevnup.prototype._iOwnVNode = function _iOwnVNode(vnodeName) {
    // Use the non-patched lookup
    var node = this.hashRingLookup(vnodeName);
    return this.hashRing.whoami() === node;
};

Sevnup.prototype._getOwnedVNodes = function _getOwnedVNodes() {
    var results = [];
    for (var i = 0; i < this.totalVNodes; ++i) {
        if (this._iOwnVNode(i)) {
            results.push(i);
        }
    }
    return results;
};

/**
 * Takes a hashRing and subscribes to the correct events to maintain VNode
 * ownership.
 * @param {object} hashRing A ringPop implementation of a hashring.
 */
Sevnup.prototype._onRingStateChange = function _onRingStateChange() {
    var self = this;
    if (this.calmTimeout) {
        clearTimeout(this.calmTimeout);
    }
    this.calmTimeout = setTimeout(execute, this.calmThreshold);

    function execute() {
        var oldOwnedVNodes = self.ownedVNodes;
        var newOwnedVNodes = self.ownedVNodes = self._getOwnedVNodes();

        var nodesToRelease = _.difference(oldOwnedVNodes, newOwnedVNodes);
        var nodesToRecover = _.difference(newOwnedVNodes, oldOwnedVNodes);

        self.logger.info('Sevnup._onRingStateChange', {
            releasing: nodesToRelease,
            recovering: nodesToRecover
        });

        async.parallel([
            self._forEachKeyInVNodes.bind(self, nodesToRelease, self._releaseKey.bind(self)),
            self._forEachKeyInVNodes.bind(self, nodesToRecover, self._recoverKey.bind(self))
        ], function() {
            nodesToRelease.forEach(self.store.releaseFromCache.bind(self.store));
        });
    }
};

Sevnup.prototype._forEachKeyInVNodes = function _forEachKeyInVNodes(vnodes, onKey, done) {
    var self = this;

    async.eachLimit(vnodes, MAX_PARALLEL_TASKS, onVNode, done);

    function onVNode(vnode, next) {
        async.waterfall([
            self.store.loadKeys.bind(self.store, vnode),
            onKeys.bind(null, vnode),
        ], next);
    }

    function onKeys(vnode, keys, next) {
        async.eachLimit(keys, MAX_PARALLEL_TASKS, onKey.bind(null, vnode), next);
    }
};

Sevnup.prototype._recoverKey = function _recoverKey(vnode, key, done) {
    var self = this;

    async.waterfall([
        this.recoverKeyCallback.bind(this, key),
        function(handled, next) {
            if (handled) {
                self.store.removeKey(vnode, key, function(err) {
                    if (err) {
                        self.logger.error("Sevnup._recoverKey failed to remove key from vnode", {
                            vnode: vnode,
                            key: key,
                            error: err
                        });
                    }
                    // Swallow
                    next();
                });
            } else {
                next();
            }
        }
    ], function(err) {
        if (err) {
            self.logger.error("Sevnup._recoverKey encountered an error", {
                vnode: vnode,
                key: key,
                error: err
            });
        }
        // Swallow
        done();
    });
};

Sevnup.prototype._releaseKey = function _releaseKey(vnode, key, done) {
    var self = this;
    this.releaseKeyCallback(key, function(err) {
        if (err) {
            self.logger.error("Sevnup._releaseKey encountered an error", {
                vnode: vnode,
                key: key,
                error: err
            });
        }
        // Swallow
        done();
    });
};


/**
 * When you are done working on a key, or no longer want it within bookkeeping
 * you can alert sevnup to forget it.  This notifies the ring that it doesn't
 * need attention in the event this node goes down or hands off ownership.
 * We want the service to be ignorant of vnodes so we rediscover the vnode.
 * @param {string} key The key you have finished work on.
 * @param {function} done Optional callback if you want to listen to completion
 */
Sevnup.prototype.workCompleteOnKey = function workCompleteOnKey(key, done) {
    var vnode = this._getVNodeForKey(key);
    this.store.removeKey(vnode, key, done);
};

/**
 * Given a key, get the vnode it belongs to.  It can then be routed to the
 * correct node, via looking up by vnode name.
 * @param {string} key The key to match to a vnode.
 */
Sevnup.prototype._getVNodeForKey = function _getVNodeForKey(key) {
    return farmhash.hash32(key) % this.totalVNodes;
};
