#!/usr/bin/env node
const glob = require("glob");
const babylon = require("babylon");
const { default: traverse } = require("@babel/traverse");
const path = require("path");

const args = process.argv.slice(2);
const fs = require("fs");
const cwd = process.cwd();

const promiseSyncAll = (all, fn) => {
  return new Promise(resolve => {
    resolve(all
      .map(data => () => fn(data))
      .reduce((promise, fn) => promise.then(fn), Promise.resolve())
    );
  });
}

class JSFile {
  constructor(filepath) {
    this.filepath = filepath;
    this.imports = [];
    this.maps = undefined;
    this.source = "";
    this.ast = undefined;
  }

  getAST() {
    return new Promise(resolve => {
      this.ast = babylon.parse(this.source, {
        sourceType: "module",
        plugins: ["classProperties", "decorators", "jsx", "objectRestSpread"]
      });

      resolve();
    });
  }

  getImports() {
    return Promise.resolve()
      .then(this.readFile.bind(this))
      .then(this.getImportsFromSource.bind(this))
  }

  getImportsFromSource() {
    return Promise.resolve(this)
      .then(this.getAST.bind(this))
      .then(this.getImportsFromAST.bind(this))
  }

  getImportsFromAST() {
    return new Promise(resolve => {
      this.imports.length = 0;
      traverse(this.ast, { 
        ImportDeclaration: importDeclaration => {
          const source = importDeclaration.node.source;
          if (source.type !== "StringLiteral") throw new Error(`Import source is not a string (${this.filepath}:${source.loc.start.line}:${source.loc.start.column}`);
          this.imports.push([source.value, source.start, source.end, importDeclaration.node.start, importDeclaration.node.end]);
        }
      });
      resolve();
    });
  }

  get oldLocation() {
    const { reversed } = this.maps;
    return reversed[this.filepath] || this.filepath;
  }

  getNewSourceLocation(original) {
    return () => {
      return new Promise(resolve => {
        const { map } = this.maps;
        let relative = false;
        let abs = original;

        // relative?
        if (abs && abs.charAt(0) === ".") {
          abs = path.join(path.dirname(this.oldLocation), abs);
          relative = true;
        }
  
        const found = 
          abs in map                ? abs :
          abs + "/index.js" in map  ? abs + "/index.js" :
          abs + "/index.jsx" in map ? abs + "/index.jsx" :
          abs + ".js" in map        ? abs + ".js" :
          abs + ".jsx" in map       ? abs + ".jsx" :
          undefined;

        const moved = found ? map[found] : undefined;

        console.log(
          moved && relative ? `  * ${original} => ${moved}` : // moved a relative path
          moved             ? `  - ${original} => ${moved}` : // moved
          moved === false   ? `  X ${original}` :             // deleted
                              `  . ${original}`               // untouched
        );

        resolve(moved);
      });
    }
  }

  readFile() {
    return Promise.resolve(this.filepath)
      .then(readFile)
      .then(source => this.source = source)
  }

  refactor() {
    return new Promise(resolve => {
      const source = this.source;
      const reverse = this.imports.slice().reverse(); // refactor in reverse order

      resolve(
        promiseSyncAll(reverse, importData => {
          return this.refactorImport(importData);
        })
      );
    });
  }

  refactorImport([importSource, importSourceStart, importSourceEnd, importStart, importEnd]) {
    return Promise.resolve()
      .then(this.getNewSourceLocation(importSource))
      .then(this.updateImportSource(importSourceStart, importSourceEnd, importStart, importEnd));
  }

  refactorImports(map) {
    this.maps = map;

    return Promise.resolve()
      .then(this.getImports.bind(this))
      .then(this.updateSource.bind(this))
  }

  save() {
    return new Promise((resolve, reject) => {
      fs.writeFile(this.filepath, this.source, 'utf8', err => {
        if (err) return reject(err);
        resolve();
      });
    }); //*/
  }

  storeSource(source) {
    this.source = source;
  }

  updateImportSource(importSourceStart, importSourceEnd, importStart, importEnd) {
    return newSource => {
      if (newSource === false) {
        return new Promise(resolve => {
          this.source = this.source.substr(0, importStart) + this.source.substr(importEnd);
          const lineStart = this.source.substr(0, importStart).lastIndexOf('\n') + 1;
          const lineEnd = this.source.indexOf('\n', lineStart);
          const line = this.source.substring(lineStart, lineEnd);
          if (/^ *(?:\/\/.*)?$/.test(line)) {
            this.source = this.source.substr(0, lineStart) + this.source.substr(lineEnd + 1);
          }
          resolve();
        });
      }

      if (!newSource) return Promise.resolve();

      return new Promise(resolve => {
        this.source = this.source.substr(0, importSourceStart) + JSON.stringify(newSource) + this.source.substr(importSourceEnd);
        resolve();
      });
    }
  }

  updateSource() {
    return Promise.resolve(this.filepath)
      .then(readFile)
      .then(this.storeSource.bind(this))
      .then(this.refactor.bind(this))
      .then(this.save.bind(this))
      .then(() => this.source)
  }
}

class ImportRefactor {
  constructor(
    mapFile,
    jsFiles = "javascripts/**/*.+(jsx|js)",
    originalBase = "assets/javascripts",
    destinationBase = "javascripts"
  ) {
    this.mapFile = mapFile;
    this.jsFiles = jsFiles;
    this.originalBase = originalBase;
    this.destinationBase = destinationBase;
  }

  getJSFiles() {
    return new Promise((resolve, reject) => {
      glob(this.jsFiles, {}, (err, files) => {
        if(err) return reject(err);
        this.files = files;
        resolve();
      });
    });
  }

  normalizeImport(source) {
    if (typeof source !== 'string') {
      return source;
    }
    if (source.substr(-10) === "/index.jsx") {
      return source.substr(0, source.length - 10);
    }
    if (source.substr(-9) === "/index.js") {
      return source.substr(0, source.length - 9);
    }
    if (source.substr(-4) === ".jsx") {
      return source.substr(0, source.length - 4);
    }
    if (source.substr(-3) === ".js") {
      return source.substr(0, source.length - 3);
    }
    return source;
  }

  normalizeMap(map) {
    return new Promise(resolve => {
      const normalized = {};
      const reversed = {};
  
      Object.keys(map).forEach(key => {
        const value = map[key];
        normalized[key] = this.normalizeImport(value);
        reversed[path.join(this.destinationBase, value || key)] = key;
      });
  
      this.maps = { map:normalized, reversed };
      resolve();
    });
  }

  refactorFiles() {
    return new Promise(resolve => {
      const files = this.files; //.slice(0,10);

      resolve(
        promiseSyncAll(files, filepath => {
          console.log(filepath);
          return (new JSFile(filepath)).refactorImports(this.maps);
        })
      );
    });
  }

  run() {
    return Promise.resolve(this.mapFile)
      .then(readFile)
      .then(parseJSON)
      .then(this.normalizeMap.bind(this))
      .then(this.getJSFiles.bind(this))
      .then(this.refactorFiles.bind(this))
  }
}

function parseJSON(jsonStr) {
  return new Promise(resolve => {
    resolve(JSON.parse(jsonStr));
  });
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    fs.readFile(file, "utf8", (err, source) => {
      if (err) return reject(err);
      resolve(source);
    });
  });
}

(new ImportRefactor(...args))
  .run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });