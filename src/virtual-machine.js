var EventEmitter = require('events');
var util = require('util');

var Runtime = require('./engine/runtime');

var sb2 = require('./serialization/sb2');
var sb3 = require('./serialization/sb3');

/**
 * Handles connections between blocks, stage, and extensions.
 * @constructor
 */
var VirtualMachine = function () {
    var instance = this;
    // Bind event emitter and runtime to VM instance
    EventEmitter.call(instance);
    /**
     * VM runtime, to store blocks, I/O devices, sprites/targets, etc.
     * @type {!Runtime}
     */
    instance.runtime = new Runtime();
    /**
     * The "currently editing"/selected target ID for the VM.
     * Block events from any Blockly workspace are routed to this target.
     * @type {!string}
     */
    instance.editingTarget = null;
    // Runtime emits are passed along as VM emits.
    instance.runtime.on(Runtime.SCRIPT_GLOW_ON, function (glowData) {
        instance.emit(Runtime.SCRIPT_GLOW_ON, glowData);
    });
    instance.runtime.on(Runtime.SCRIPT_GLOW_OFF, function (glowData) {
        instance.emit(Runtime.SCRIPT_GLOW_OFF, glowData);
    });
    instance.runtime.on(Runtime.BLOCK_GLOW_ON, function (glowData) {
        instance.emit(Runtime.BLOCK_GLOW_ON, glowData);
    });
    instance.runtime.on(Runtime.BLOCK_GLOW_OFF, function (glowData) {
        instance.emit(Runtime.BLOCK_GLOW_OFF, glowData);
    });
    instance.runtime.on(Runtime.PROJECT_RUN_START, function () {
        instance.emit(Runtime.PROJECT_RUN_START);
    });
    instance.runtime.on(Runtime.PROJECT_RUN_STOP, function () {
        instance.emit(Runtime.PROJECT_RUN_STOP);
    });
    instance.runtime.on(Runtime.VISUAL_REPORT, function (visualReport) {
        instance.emit(Runtime.VISUAL_REPORT, visualReport);
    });
    instance.runtime.on(Runtime.SPRITE_INFO_REPORT, function (spriteInfo) {
        instance.emit(Runtime.SPRITE_INFO_REPORT, spriteInfo);
    });

    this.blockListener = this.blockListener.bind(this);
    this.flyoutBlockListener = this.flyoutBlockListener.bind(this);
};

/**
 * Inherit from EventEmitter
 */
util.inherits(VirtualMachine, EventEmitter);

/**
 * Start running the VM - do this before anything else.
 */
VirtualMachine.prototype.start = function () {
    this.runtime.start();
};

/**
 * "Green flag" handler - start all threads starting with a green flag.
 */
VirtualMachine.prototype.greenFlag = function () {
    this.runtime.greenFlag();
};

/**
 * Set whether the VM is in "turbo mode."
 * When true, loops don't yield to redraw.
 * @param {boolean} turboModeOn Whether turbo mode should be set.
 */
VirtualMachine.prototype.setTurboMode = function (turboModeOn) {
    this.runtime.turboMode = !!turboModeOn;
};

/**
 * Set whether the VM is in 2.0 "compatibility mode."
 * When true, ticks go at 2.0 speed (30 TPS).
 * @param {boolean} compatibilityModeOn Whether compatibility mode is set.
 */
VirtualMachine.prototype.setCompatibilityMode = function (compatibilityModeOn) {
    this.runtime.setCompatibilityMode(!!compatibilityModeOn);
};

/**
 * Stop all threads and running activities.
 */
VirtualMachine.prototype.stopAll = function () {
    this.runtime.stopAll();
};

/**
 * Clear out current running project data.
 */
VirtualMachine.prototype.clear = function () {
    this.runtime.dispose();
    this.editingTarget = null;
    this.emitTargetsUpdate();
};

/**
 * Get data for playground. Data comes back in an emitted event.
 */
VirtualMachine.prototype.getPlaygroundData = function () {
    var instance = this;
    // Only send back thread data for the current editingTarget.
    var threadData = this.runtime.threads.filter(function (thread) {
        return thread.target === instance.editingTarget;
    });
    // Remove the target key, since it's a circular reference.
    var filteredThreadData = JSON.stringify(threadData, function (key, value) {
        if (key === 'target') return;
        return value;
    }, 2);
    this.emit('playgroundData', {
        blocks: this.editingTarget.blocks,
        threads: filteredThreadData
    });
};

/**
 * Post I/O data to the virtual devices.
 * @param {?string} device Name of virtual I/O device.
 * @param {object} data Any data object to post to the I/O device.
 */
VirtualMachine.prototype.postIOData = function (device, data) {
    if (this.runtime.ioDevices[device]) {
        this.runtime.ioDevices[device].postData(data);
    }
};

/**
 * Load a project from a Scratch 2.0 JSON representation.
 * @param {?string} json JSON string representing the project.
 */
VirtualMachine.prototype.loadProject = function (json) {
    this.clear();
    // @todo: Handle other formats, e.g., Scratch 1.4.
    this.fromJSON(json, this.runtime);
    // Select the first target for editing, e.g., the first sprite.
    this.editingTarget = this.runtime.targets[1];
    // Update the VM user's knowledge of targets and blocks on the workspace.
    this.emitTargetsUpdate();
    this.emitWorkspaceUpdate();
    this.runtime.setEditingTarget(this.editingTarget);
};

/**
 * return a project in a Scratch 3.0 JSON representation.
 */
VirtualMachine.prototype.saveProjectSb3 = function () {
    // @todo: Handle other formats, e.g., Scratch 1.4, Scratch 2.0.
    return this.toJSON();
}

/**
 * Export project as a Scratch 3.0 JSON representation.
 * @return {string} Serialized state of the runtime.
 */
VirtualMachine.prototype.toJSON = function () {
    return JSON.stringify(sb3.serialize(this.runtime));
};

/**
 * Load a project from a Scratch JSON representation.
 * @param {string} json JSON string representing a project.
 */
VirtualMachine.prototype.fromJSON = function (json) {
    // Clear the current runtime
    this.clear();

    // Validate & parse
    if (typeof json !== 'string') return;
    json = JSON.parse(json);
    if (typeof json !== 'object') return;

    // Establish version, deserialize, and load into runtime
    // @todo Support Scratch 1.4
    // @todo This is an extremely naïve / dangerous way of determining version.
    //       See `scratch-parser` for a more sophisticated validation
    //       methodology that should be adapted for use here
    if ((typeof json.meta !== 'undefined') && (typeof json.meta.semver !== 'undefined') ) {
        sb3.deserialize(json, this.runtime);
    } else {
        sb2.deserialize(json, this.runtime);
    }

    // Select the first target for editing, e.g., the first sprite.
    this.editingTarget = this.runtime.targets[1];

    // Update the VM user's knowledge of targets and blocks on the workspace.
    this.emitTargetsUpdate();
    this.emitWorkspaceUpdate();
    this.runtime.setEditingTarget(this.editingTarget);
};

/**
 * Add a single sprite from the "Sprite2" (i.e., SB2 sprite) format.
 * @param {?string} json JSON string representing the sprite.
 */
VirtualMachine.prototype.addSprite2 = function (json) {
    // Select new sprite.
    this.editingTarget = sb2.deserialize(json, this.runtime, true);
    //console.log(this.editingTarget)
    // Update the VM user's knowledge of targets and blocks on the workspace.
    this.emitTargetsUpdate();
    this.emitWorkspaceUpdate();
    this.runtime.setEditingTarget(this.editingTarget);
};

/**
 * Add a costume to the current editing target.
 * @param {!object} costumeObject Object representing the costume.
 */
VirtualMachine.prototype.addCostume = function (costumeObject) {
    this.editingTarget.sprite.costumes.push(costumeObject);
    // Switch to the costume.
    this.editingTarget.setCostume(
        this.editingTarget.sprite.costumes.length - 1
    );
};

/**
 * Add a backdrop to the stage.
 * @param {!object} backdropObject Object representing the backdrop.
 */
VirtualMachine.prototype.addBackdrop = function (backdropObject) {
    var stage = this.runtime.getTargetForStage();
    stage.sprite.costumes.push(backdropObject);
    // Switch to the backdrop.
    stage.setCostume(stage.sprite.costumes.length - 1);
};

/**
 * Rename a sprite.
 * @param {string} targetId ID of a target whose sprite to rename.
 * @param {string} newName New name of the sprite.
 */
VirtualMachine.prototype.renameSprite = function (targetId, newName) {
    var target = this.runtime.getTargetById(targetId);
    if (target) {
        if (!target.isSprite()) {
            throw new Error('Cannot rename non-sprite targets.');
        }
        var sprite = target.sprite;
        if (!sprite) {
            throw new Error('No sprite associated with this target.');
        }
        sprite.name = newName;
        this.emitTargetsUpdate();
    } else {
        throw new Error('No target with the provided id.');
    }
};

/**
 * Delete a sprite and all its clones.
 * @param {string} targetId ID of a target whose sprite to delete.
 */
VirtualMachine.prototype.deleteSprite = function (targetId) {
    var target = this.runtime.getTargetById(targetId);
    if (target) {
        if (!target.isSprite()) {
            throw new Error('Cannot delete non-sprite targets.');
        }
        var sprite = target.sprite;
        if (!sprite) {
            throw new Error('No sprite associated with this target.');
        }
        var currentEditingTarget = this.editingTarget;
        for (var i = 0; i < sprite.clones.length; i++) {
            var clone = sprite.clones[i];
            this.runtime.stopForTarget(sprite.clones[i]);
            this.runtime.disposeTarget(sprite.clones[i]);
            // Ensure editing target is switched if we are deleting it.
            if (clone === currentEditingTarget) {
                this.setEditingTarget(this.runtime.targets[0].id);
            }
        }
        // Sprite object should be deleted by GC.
        this.emitTargetsUpdate();
    } else {
        throw new Error('No target with the provided id.');
    }
};

/**
 * Set the renderer for the VM/runtime
 * @param {!RenderWebGL} renderer The renderer to attach
 */
VirtualMachine.prototype.attachRenderer = function (renderer) {
    this.runtime.attachRenderer(renderer);
};

/**
 * Set the audio engine for the VM/runtime
 * @param {!AudioEngine} audioEngine The audio engine to attach
 */
VirtualMachine.prototype.attachAudioEngine = function (audioEngine) {
    this.runtime.attachAudioEngine(audioEngine);
};

/**
 * Handle a Blockly event for the current editing target.
 * @param {!Blockly.Event} e Any Blockly event.
 */
VirtualMachine.prototype.blockListener = function (e) {
    if (this.editingTarget) {
        this.editingTarget.blocks.blocklyListen(e, this.runtime);
    }
};

/**
 * Handle a Blockly event for the flyout.
 * @param {!Blockly.Event} e Any Blockly event.
 */
VirtualMachine.prototype.flyoutBlockListener = function (e) {
    this.runtime.flyoutBlocks.blocklyListen(e, this.runtime);
};

/**
 * Set an editing target. An editor UI can use this function to switch
 * between editing different targets, sprites, etc.
 * After switching the editing target, the VM may emit updates
 * to the list of targets and any attached workspace blocks
 * (see `emitTargetsUpdate` and `emitWorkspaceUpdate`).
 * @param {string} targetId Id of target to set as editing.
 */
VirtualMachine.prototype.setEditingTarget = function (targetId) {
    // Has the target id changed? If not, exit.
    if (targetId === this.editingTarget.id) {
        return;
    }
    var target = this.runtime.getTargetById(targetId);
    if (target) {
        this.editingTarget = target;
        // Emit appropriate UI updates.
        this.emitTargetsUpdate();
        this.emitWorkspaceUpdate();
        this.runtime.setEditingTarget(target);
    }
};

/**
 * Emit metadata about available targets.
 * An editor UI could use this to display a list of targets and show
 * the currently editing one.
 */
VirtualMachine.prototype.emitTargetsUpdate = function () {
    this.emit('targetsUpdate', {
        // [[target id, human readable target name], ...].
        targetList: this.runtime.targets.filter(function (target) {
            // Don't report clones.
            return !target.hasOwnProperty('isOriginal') || target.isOriginal;
        }).map(function (target) {
            return target.toJSON();
        }),
        // Currently editing target id.
        editingTarget: this.editingTarget ? this.editingTarget.id : null
    });
};

/**
 * Emit an Blockly/scratch-blocks compatible XML representation
 * of the current editing target's blocks.
 */
VirtualMachine.prototype.emitWorkspaceUpdate = function () {
    this.emit('workspaceUpdate', {
        xml: this.editingTarget.blocks.toXML()
    });
};

/**
 * Get a target id for a drawable id. Useful for interacting with the renderer
 * @param {int} drawableId The drawable id to request the target id for
 * @returns {?string} The target id, if found. Will also be null if the target found is the stage.
 */
VirtualMachine.prototype.getTargetIdForDrawableId = function (drawableId) {
    var target = this.runtime.getTargetByDrawableId(drawableId);
    if (target && target.hasOwnProperty('id') && target.hasOwnProperty('isStage') && !target.isStage) {
        return target.id;
    }
    return null;
};

/**
 * Put a target into a "drag" state, during which its X/Y positions will be unaffected
 * by blocks.
 * @param {string} targetId The id for the target to put into a drag state
 */
VirtualMachine.prototype.startDrag = function (targetId) {
    var target = this.runtime.getTargetById(targetId);
    if (target) {
        target.startDrag();
        this.setEditingTarget(target.id);
    }
};

/**
 * Remove a target from a drag state, so blocks may begin affecting X/Y position again
 * @param {string} targetId The id for the target to remove from the drag state
 */
VirtualMachine.prototype.stopDrag = function (targetId) {
    var target = this.runtime.getTargetById(targetId);
    if (target) target.stopDrag();
};

/**
 * Post/edit sprite info for the current editing target.
 * @param {object} data An object with sprite info data to set.
 */
VirtualMachine.prototype.postSpriteInfo = function (data) {
    this.editingTarget.postSpriteInfo(data);
};

module.exports = VirtualMachine;
