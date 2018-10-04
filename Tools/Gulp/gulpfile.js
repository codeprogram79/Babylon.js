// Gulp Tools
var gulp = require("gulp");
var uglify = require("gulp-uglify");
var typescript = require("gulp-typescript");
var sourcemaps = require("gulp-sourcemaps");
var srcToVariable = require("gulp-content-to-variable");
var merge2 = require("merge2");
var concat = require("gulp-concat");
var rename = require("gulp-rename");
var cleants = require("gulp-clean-ts-extends");
var replace = require("gulp-replace");
var expect = require("gulp-expect-file");
var optimisejs = require("gulp-optimize-js");
var path = require("path");
var webpack = require('webpack');
var webpackStream = require("webpack-stream");
var fs = require("fs");
var dtsBundle = require('dts-bundle');
var through = require('through2');

// Gulp Helpers
var appendSrcToVariable = require("./helpers/gulp-appendSrcToVariable");
var addDtsExport = require("./helpers/gulp-addDtsExport");
var addDecorateAndExtends = require("./helpers/gulp-decorateAndExtends");
var addModuleExports = require("./helpers/gulp-addModuleExports");
var addES6Exports = require("./helpers/gulp-addES6Exports");
var uncommentShader = require("./helpers/gulp-removeShaderComments");

// Import Gulp Tasks
require("./tasks/gulpTasks-tsLint");
require("./tasks/gulpTasks-netlify");
require("./tasks/gulpTasks-whatsNew");
require("./tasks/gulpTasks-localRun");
require("./tasks/gulpTasks-watch");
require("./tasks/gulpTasks-typedoc");
require("./tasks/gulpTasks-intellisense");
require("./tasks/gulpTasks-tests");

var processDeclaration = require('./helpers/processViewerDeclaration');

var config = require("./config.json");

var includeShadersStream;
var shadersStream;
var workersStream;

var extendsSearchRegex = /var\s__extends[\s\S]+?\}\)\(\);/g;
var decorateSearchRegex = /var\s__decorate[\s\S]+?\};/g;
var referenceSearchRegex = /\/\/\/ <reference.*/g;

/**
 * TS configurations shared in the gulp file.
 */
var tsConfig = {
    noResolve: true,
    target: "ES5",
    declarationFiles: true,
    typescript: require("typescript"),
    experimentalDecorators: true,
    isolatedModules: false,
    noImplicitAny: true,
    noImplicitReturns: true,
    noImplicitThis: true,
    noUnusedLocals: true,
    strictNullChecks: true,
    strictFunctionTypes: true,
    types: [],
    lib: [
        "dom",
        "es2015.promise",
        "es5"
    ]
};
var tsProject = typescript.createProject(tsConfig);

var externalTsConfig = {
    noResolve: false,
    target: "ES5",
    declarationFiles: true,
    typescript: require("typescript"),
    experimentalDecorators: true,
    isolatedModules: false,
    noImplicitAny: true,
    noImplicitReturns: true,
    noImplicitThis: true,
    noUnusedLocals: true,
    strictNullChecks: true,
    types: [],
    lib: [
        "dom",
        "es2015.promise",
        "es5"
    ]
};

function processDependency(kind, dependency, filesToLoad, firstLevelOnly) {
    if (!firstLevelOnly && dependency.dependUpon) {
        for (var i = 0; i < dependency.dependUpon.length; i++) {
            var dependencyName = dependency.dependUpon[i];
            var parent = config.workloads[dependencyName];
            processDependency(kind, parent, filesToLoad);
        }
    }

    var content = dependency[kind];
    if (!content) {
        return;
    }

    for (var i = 0; i < content.length; i++) {
        var file = content[i];

        if (filesToLoad.indexOf(file) === -1) {
            filesToLoad.push(file);
        }
    }
}

function determineFilesToProcess(kind) {
    var currentConfig = config.build.currentConfig;
    var buildConfiguration = config.buildConfigurations[currentConfig];
    var filesToLoad = [];

    for (var index = 0; index < buildConfiguration.length; index++) {
        var dependencyName = buildConfiguration[index];
        var dependency = config.workloads[dependencyName];

        if (kind === "directFiles" && !dependency) {
            filesToLoad.push("../../dist/preview release/" + dependencyName);
        }
        else if (dependency) {
            processDependency(kind, dependency, filesToLoad);
        }
    }

    if (kind === "shaderIncludes") {
        for (var index = 0; index < filesToLoad.length; index++) {
            filesToLoad[index] = "../../src/Shaders/ShadersInclude/" + filesToLoad[index] + ".fx";
        }
    } else if (kind === "shaders") {
        for (var index = 0; index < filesToLoad.length; index++) {
            var name = filesToLoad[index];
            filesToLoad[index] = "../../src/Shaders/" + filesToLoad[index] + ".fx";
        }
    }

    return filesToLoad;
}

/*
 * Shader Management.
 */
function shadersName(filename) {
    return path.basename(filename)
        .replace(".fragment", "Pixel")
        .replace(".vertex", "Vertex")
        .replace(".fx", "Shader");
}

function includeShadersName(filename) {
    return path.basename(filename).replace(".fx", "");
}

/*
 * Main necessary files stream Management.
 */
gulp.task("includeShaders", function(cb) {
    var filesToProcess = determineFilesToProcess("shaderIncludes");
    includeShadersStream = gulp.src(filesToProcess).
        pipe(expect.real({ errorOnFailure: true }, filesToProcess)).
        pipe(uncommentShader()).
        pipe(srcToVariable({
            variableName: "BABYLON.Effect.IncludesShadersStore", asMap: true, namingCallback: includeShadersName
        }));
    cb();
});

gulp.task("shaders", gulp.series("includeShaders", function(cb) {
    var filesToProcess = determineFilesToProcess("shaders");
    shadersStream = gulp.src(filesToProcess).
        pipe(expect.real({ errorOnFailure: true }, filesToProcess)).
        pipe(uncommentShader()).
        pipe(srcToVariable({
            variableName: "BABYLON.Effect.ShadersStore", asMap: true, namingCallback: shadersName
        }));
    cb();
}));

gulp.task("workers", function(cb) {
    workersStream = config.workers.map(function(workerDef) {
        return gulp.src(workerDef.files).
            pipe(expect.real({ errorOnFailure: true }, workerDef.files)).
            pipe(uglify()).
            pipe(srcToVariable({
                variableName: workerDef.variable
            }));
    });
    cb();
});

/**
 * Build tasks to concat minify uflify optimise the BJS js in different flavor (workers...).
 */
gulp.task("buildWorker", gulp.series(gulp.parallel("workers", "shaders"), function() {
    var filesToProcess = determineFilesToProcess("files");
    return merge2(
        gulp.src(filesToProcess).
            pipe(expect.real({ errorOnFailure: true }, filesToProcess)),
        shadersStream,
        includeShadersStream,
        workersStream
    )
        .pipe(concat(config.build.minWorkerFilename))
        .pipe(cleants())
        .pipe(replace(extendsSearchRegex, ""))
        .pipe(replace(decorateSearchRegex, ""))
        .pipe(addDecorateAndExtends())
        .pipe(addModuleExports("BABYLON", {
            dependencies: config.build.dependencies
        }))
        .pipe(uglify())
        .pipe(optimisejs())
        .pipe(gulp.dest(config.build.outputDirectory));
}));

gulp.task("build", gulp.series("shaders", function build() {
    var filesToProcess = determineFilesToProcess("files");
    var directFilesToProcess = determineFilesToProcess("directFiles");
    let mergedStreams = merge2(gulp.src(filesToProcess)
        .pipe(expect.real({ errorOnFailure: true }, filesToProcess)),
        shadersStream,
        includeShadersStream);
    if (directFilesToProcess.length) {
        mergedStreams.add(gulp.src(directFilesToProcess));
    }
    return merge2(
        mergedStreams
            .pipe(concat(config.build.noModuleFilename))
            .pipe(cleants())
            .pipe(replace(extendsSearchRegex, ""))
            .pipe(replace(decorateSearchRegex, ""))
            .pipe(addDecorateAndExtends())
            .pipe(gulp.dest(config.build.outputDirectory))
            .pipe(rename(config.build.filename))
            .pipe(addModuleExports("BABYLON", {
                dependencies: config.build.dependencies
            }))
            .pipe(gulp.dest(config.build.outputDirectory))
            .pipe(rename(config.build.minFilename))
            .pipe(uglify())
            .pipe(optimisejs())
            .pipe(gulp.dest(config.build.outputDirectory)),
        mergedStreams
            .pipe(concat("es6.js"))
            .pipe(cleants())
            .pipe(replace(extendsSearchRegex, ""))
            .pipe(replace(decorateSearchRegex, ""))
            .pipe(addES6Exports("BABYLON"))
            .pipe(gulp.dest(config.build.outputDirectory))
    );
}));

/*
* Compiles all typescript files and creating a js and a declaration file.
*/
gulp.task("typescript-compile", function() {
    var tsResult = gulp.src(config.typescript)
        .pipe(sourcemaps.init())
        .pipe(tsProject({
            summarizeFailureOutput: true
        }));

    //If this gulp task is running on travis, file the build!
    if (process.env.TRAVIS) {
        tsResult.once("error", function() {
            tsResult.once("finish", function() {
                console.log("Typescript compile failed");
                process.exit(1);
            });
        });
    }

    return merge2([
        tsResult.dts
            .pipe(concat(config.build.declarationFilename))
            .pipe(addDtsExport("BABYLON", "babylonjs"))
            .pipe(gulp.dest(config.build.outputDirectory)),
        tsResult.js
            .pipe(sourcemaps.write("./",
                {
                    includeContent: false,
                    sourceRoot: (filePath) => {
                        return "";
                    }
                }))
            .pipe(gulp.dest(config.build.srcOutputDirectory))
    ])
});

/**
 * Build the releasable files.
 */
gulp.task("typescript", gulp.series("typescript-compile", "buildWorker", "build"));

/**
 * Helper methods to build external library (mat, post processes, ...).
 */
var buildExternalLibraries = function(settings) {
    var tasks = settings.libraries.map(function(library) {
        return buildExternalLibrary(library, settings, false);
    });

    let mergedTasks = merge2(tasks);

    if (settings.build.buildAsModule) {
        mergedTasks.on("end", function() {
            //generate js file list
            let files = settings.libraries.filter(function(lib) {
                return !lib.doNotIncludeInBundle;
            }).map(function(lib) {
                return config.build.outputDirectory + settings.build.distOutputDirectory + lib.output;
            });

            var outputDirectory = config.build.outputDirectory + settings.build.distOutputDirectory;

            let srcTask = gulp.src(files)
                .pipe(concat(settings.build.outputFilename + ".js"))
                .pipe(replace(extendsSearchRegex, ""))
                .pipe(replace(decorateSearchRegex, ""))
                .pipe(replace(referenceSearchRegex, ""))
                .pipe(addDecorateAndExtends())
                .pipe(addModuleExports(settings.build.moduleDeclaration, { subModule: true, extendsRoot: settings.build.extendsRoot }))
                .pipe(gulp.dest(outputDirectory))
                .pipe(cleants())
                .pipe(rename({ extname: ".min.js" }))
                .pipe(uglify())
                .pipe(optimisejs())
                .pipe(gulp.dest(outputDirectory));

            let dtsFiles = files.map(function(filename) {
                return filename.replace(".js", ".d.ts");
            });
            let dtsModuleTask = gulp.src(dtsFiles)
                .pipe(concat(settings.build.outputFilename + ".module.d.ts"))
                .pipe(replace(referenceSearchRegex, ""))
                .pipe(addDtsExport(settings.build.moduleDeclaration, settings.build.moduleName, true, settings.build.extendsRoot, settings.build.extraTypesDependencies))
                .pipe(gulp.dest(outputDirectory));
            let dtsTask = gulp.src(dtsFiles)
                .pipe(concat(settings.build.outputFilename + ".d.ts"))
                .pipe(replace(referenceSearchRegex, ""))
                .pipe(gulp.dest(outputDirectory));

            return merge2([srcTask, dtsTask, dtsModuleTask]);
        });
    }

    return mergedTasks;
}

var buildExternalLibrary = function(library, settings, watch) {
    var tsProcess;
    if (library.files && library.files.length) {
        tsProcess = gulp.src(library.files, { base: settings.build.srcOutputDirectory })
            .pipe(sourcemaps.init())
            .pipe(typescript(externalTsConfig));
    }

    let tasks = [];

    let shaderTask;

    let shadersInclueTask;

    if (library.shadersIncludeFiles && library.shadersIncludeFiles.length) {
        shadersInclueTask = gulp.src(library.shadersIncludeFiles, { base: settings.build.srcOutputDirectory })
            .pipe(uncommentShader())
            .pipe(appendSrcToVariable("BABYLON.Effect.IncludesShadersStore", includeShadersName, library.output + ".include.fx"))
            .pipe(gulp.dest(settings.build.srcOutputDirectory));
        tasks.push(shadersInclueTask);
    }

    if (library.shaderFiles && library.shaderFiles.length) {
        shaderTask = gulp.src(library.shaderFiles, { base: settings.build.srcOutputDirectory })
            .pipe(uncommentShader())
            .pipe(appendSrcToVariable("BABYLON.Effect.ShadersStore", shadersName, library.output + ".fx"))
            .pipe(gulp.dest(settings.build.srcOutputDirectory));
        tasks.push(shaderTask);
    }

    var dev;

    if (tsProcess) {
        dev = tsProcess.js
            .pipe(sourcemaps.write("./", {
                includeContent: false,
                sourceRoot: (filePath) => {
                    return "";
                }
            })).pipe(gulp.dest(settings.build.srcOutputDirectory));

        tasks.push(dev);
    }

    var outputDirectory = config.build.outputDirectory + settings.build.distOutputDirectory;

    if (watch) {
        return merge2(tasks);
    }
    else {
        let currentTasks = [];
        if (tsProcess) {
            currentTasks.push(tsProcess.js);
        }
        if (shaderTask) {
            currentTasks.push(shaderTask);
        }
        if (shadersInclueTask) {
            currentTasks.push(shadersInclueTask);
        }
        var code;

        if (currentTasks.length) {
            code = merge2(currentTasks)
                .pipe(concat(library.output));
        }

        if (library.buildAsModule && code) {
            code = code.pipe(replace(extendsSearchRegex, ""))
                .pipe(replace(decorateSearchRegex, ""))
                .pipe(addDecorateAndExtends())
                .pipe(addModuleExports(library.moduleDeclaration, { subModule: true, extendsRoot: library.extendsRoot }))
        }

        if (code) {

            code = code.pipe(gulp.dest(outputDirectory))
                .pipe(cleants())
                .pipe(rename({ extname: ".min.js" }))
                .pipe(uglify())
                .pipe(optimisejs())
                .pipe(gulp.dest(outputDirectory));
            /*}*/

        }

        var dts;

        if (tsProcess) {
            dts = tsProcess.dts
                .pipe(concat(library.output))
                .pipe(replace(referenceSearchRegex, ""))
                .pipe(rename({ extname: ".d.ts" }))
                .pipe(gulp.dest(outputDirectory));
        }

        var waitAll;
        let waitAllTasks = [];


        if (dev) {
            waitAllTasks.push(dev);
        }

        if (code) {
            waitAllTasks.push(code);
        }

        if (dts) {
            waitAllTasks.push(dts);
        }

        if (library.buildAsModule && tsProcess) {
            var dts2 = tsProcess.dts
                .pipe(concat(library.output))
                .pipe(replace(referenceSearchRegex, ""))
                .pipe(addDtsExport(library.moduleDeclaration, library.moduleName, true, library.extendsRoot, config.build.extraTypesDependencies))
                .pipe(rename({ extname: ".module.d.ts" }))
                .pipe(gulp.dest(outputDirectory));
            waitAllTasks.push(dts2);
        }
        if (waitAllTasks.length) {
            waitAll = merge2(waitAllTasks);
        }

        if (library.webpack) {
            let sequence = [];
            if (waitAll) {
                sequence.push(waitAll);
            }

            if (settings.build.outputs) {

                settings.build.outputs.forEach(out => {
                    let wpConfig = require(library.webpack);
                    if (!out.minified) {
                        wpConfig.mode = "development";
                    }

                    let wpBuild = webpackStream(wpConfig, require("webpack"));

                    //shoud dtsBundle create the declaration?
                    if (settings.build.dtsBundle) {
                        let event = wpBuild
                            .pipe(through.obj(function(file, enc, cb) {
                                // only declaration files
                                const isdts = /\.d\.ts$/.test(file.path);
                                if (isdts) this.push(file);
                                cb();
                            }))
                            .pipe(gulp.dest(outputDirectory));
                        // dts-bundle does NOT support (gulp) streams, so files have to be saved and reloaded, 
                        // until I fix it
                        event.on("end", function() {
                            // create the file
                            dtsBundle.bundle(settings.build.dtsBundle);
                            // prepend the needed reference
                            let fileLocation = path.join(path.dirname(settings.build.dtsBundle.main), settings.build.dtsBundle.out);
                            fs.readFile(fileLocation, function(err, data) {
                                if (err) throw err;
                                data = (settings.build.dtsBundle.prependText || "") + '\n' + data.toString();
                                fs.writeFileSync(fileLocation, data);
                                if (settings.build.processDeclaration) {
                                    var newData = processDeclaration(data, settings.build.processDeclaration);
                                    fs.writeFileSync(fileLocation.replace('.module', ''), newData);
                                }
                            });
                        });
                    }

                    let build = wpBuild
                        .pipe(through.obj(function(file, enc, cb) {
                            // only pipe js files
                            const isJs = /\.js$/.test(file.path);
                            if (isJs) this.push(file);
                            cb();
                        }))
                        .pipe(addModuleExports(library.moduleDeclaration, { subModule: false, extendsRoot: false, externalUsingBabylon: true, noBabylonInit: library.babylonIncluded }));

                    function processDestination(dest) {
                        var outputDirectory = config.build.outputDirectory + dest.outputDirectory;
                        build = build
                            .pipe(rename(dest.filename.replace(".js", library.noBundleInName ? '.js' : ".bundle.js")))
                            .pipe(gulp.dest(outputDirectory));

                        if (library.babylonIncluded && dest.addBabylonDeclaration) {
                            // include the babylon declaration
                            if (dest.addBabylonDeclaration === true) {
                                dest.addBabylonDeclaration = [config.build.declarationFilename];
                            }
                            var decsToAdd = dest.addBabylonDeclaration.map(function(dec) {
                                return config.build.outputDirectory + '/' + dec;
                            });
                            sequence.unshift(gulp.src(decsToAdd)
                                .pipe(rename(function(path) {
                                    path.dirname = '';
                                }))
                                .pipe(gulp.dest(outputDirectory)))
                        }
                    }

                    out.destinations.forEach(dest => {
                        processDestination(dest);
                    });

                    sequence.push(build);

                });
            } else {
                console.log(library.output)

                var wpConfig;
                if (library.entry) {
                    wpConfig = require(settings.build.webpack);
                    wpConfig.entry = {
                        'main': path.resolve(wpConfig.context, library.entry),
                    };
                    wpConfig.output.filename = library.output;
                }
                else {
                    wpConfig = require(library.webpack);
                }

                let wpBuild = webpackStream(wpConfig, webpack);

                let buildEvent = wpBuild.pipe(gulp.dest(outputDirectory));
                sequence.push(buildEvent);

                // Generate unminified
                wpConfig.mode = "development";
                wpConfig.output.filename = wpConfig.output.filename.replace(".min", "");

                wpBuild = webpackStream(wpConfig, webpack);

                let buildEvent2 = wpBuild.pipe(gulp.dest(outputDirectory));
                sequence.push(buildEvent2);

                if (library.isMain) {
                    if (settings.build.dtsBundle || settings.build.processDeclaration) {
                        buildEvent.on("end", function() {
                            if (settings.build.dtsBundle) {
                                dtsBundle.bundle(settings.build.dtsBundle);
                            }

                            if (settings.build.processDeclaration) {
                                let fileLocation = path.join(outputDirectory, settings.build.processDeclaration.filename);
                                fs.readFile(fileLocation, function(err, data) {
                                    if (err) throw err;

                                    // For Raanan, litteral import hack TO BETTER INTEGRATE
                                    data = data + "";
                                    data = data.replace('import "../sass/main.scss";', "");

                                    var newData = processDeclaration(data, settings.build.processDeclaration);
                                    fs.writeFileSync(fileLocation.replace('.module', ''), newData);
                                    //legacy module support
                                    fs.writeFileSync(fileLocation, data + "\n" + newData);
                                });
                            }
                        });
                    }
                }
            }

            return merge2(sequence);
        }
        else {
            return waitAll || Promise.resolve();
        }
    }
}

/**
 * Dynamic module creation In Serie for WebPack leaks.
 */
function buildExternalLibrariesInSeries(settings) {
    var tasks = settings.libraries.map(function(library) {
        var build = function(cb) {
            return buildExternalLibrary(library, settings, false);
        }
        return build;
    });

    return gulp.series.apply(this, tasks);
}

/**
 * Dynamic module creation.
 */
config.modules.map(function(module) {
    // New Way
    if (!config[module].buildAsModule) {
        gulp.task(module, buildExternalLibrariesInSeries(config[module]));
    }
    // Soon To Be Gone
    else {
        gulp.task(module, function() {
            return buildExternalLibraries(config[module]);
        });
    }
});

/**
 * Build all libs.
 */
gulp.task("typescript-libraries", gulp.series(config.modules));

/**
 * Custom build with full path file control; used by profile.html
 */
gulp.task("build-custom", gulp.series("typescript-compile", "build"));

/**
 * Validate compile the code and check the comments and style case convention through typedoc
 */
gulp.task("typedoc-check", gulp.series("typescript-compile", "gui", "loaders", "serializers", "typedoc-generate", "typedoc-validate"));

/**
 * Combine Webserver and Watch as long as vscode does not handle multi tasks.
 */
gulp.task("run", gulp.series("watch", "webserver"));

/**
 * Do it all (Build).
 */
gulp.task("typescript-all", gulp.series("typescript", "typescript-libraries", "netlify-cleanup"));

/**
 * Do it all (tests).
 */
gulp.task("tests-all", gulp.series("tests-unit", "tests-modules", "tests-validation-virtualscreen", "tests-validation-browserstack"));

/**
 * The default task, concat and min the main BJS files.
 */
gulp.task("default", gulp.series("tsLint", "typescript-all", "intellisense", "typedoc-all", "tests-all"));
