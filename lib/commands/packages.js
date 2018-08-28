"use strict";

const changes     = require("../singletons/changes.js");
const exec        = require("util").promisify(require("child_process").exec);
const passthru    = require("../util/passthru.js");
const systemstate = require("../singletons/systemstate.js");
const zip         = require("../util/zip.js");

const areWeOnline = async () => {
  try {
    await exec(`apt-get update`);
    return true;
  } catch (e) {
    return false;
  }
};

const allPackages = async () =>
  (await exec(`apt list --installed | awk -F'[\/ ]' '{ print $1 " " $3 }'`))
  .stdout
  .split("\n")
  .map(s => s.trim())
  .filter(s => s.length > 0)
  .reduce(
    (acc, line) => {
      const [ name, version ] = line.split(" ");

      return Object.assign({}, acc, {
        [name]: version,
      });
    },
    {}
  )
;

const packagesOfGroup = async (group) =>
  //Groups (or meta-packages) are treated just like packages in ubuntu
  (await exec(`apt-rdepends -p ${ group } 2>/dev/null | grep "Depends" | awk '{ print $2 }' | sort | uniq `))
  .stdout
  .split("\n")
  .map(s => s.trim())
  .filter(s => s.length > 0)
;

const depsOf = async (name) => {
  try {
    return (await exec(`apt-rdepends -p ${ name } 2>/dev/null | grep "Depends" | awk '{ print $2 }' | sort | uniq`))
      .stdout
      .split("\n")
      .map(s => s.trim())
      .filter(s => s.length > 0)
    ;
  } catch (e) {
    throw new Error(`Could not look up dependencies of package "${ name }"; possibly this is a group?`);
  }
};

const filterMapOnKey = (objects, keyName) =>
  objects.filter(item => item[keyName]).map(item => item[keyName])
;

module.exports = async (defs) => {
  if (!(await areWeOnline())) {
    console.log("WARNING: network offline / apt not working. Skipping packages.");
    return;
  }

  defs = defs.map(def => {
    if (typeof def === "string") {
      return { package: def };
    } else {
      return def;
    }
  });

  const groups    = filterMapOnKey(defs, "group");
  const packages  = filterMapOnKey(defs, "package");
  const externals = filterMapOnKey(defs, "external");

  const allPackagesBeforeChanges = await allPackages();

  const installCommand = `apt-get update && apt-get install -y ${ groups.join(" ") } ${ packages.join(" ") }`;
  console.log(`PACMAN-INSTALL-COMMAND: ${ installCommand }`);
  await passthru(installCommand);

  const packagesToKeepLookup = {};
  {
    for (const group of groups) {
      for (const packageName of (await packagesOfGroup(group))) {
        packagesToKeepLookup[packageName] = true;
      }
    }

    for (const packageName of packages) {
      packagesToKeepLookup[packageName] = true;
    }

    for (const packageName of Object.keys(packagesToKeepLookup)) {
      for (const depName of (await depsOf(packageName))) {
        packagesToKeepLookup[depName] = true;
      }
    }

    for (const packageName of externals) {
      packagesToKeepLookup[packageName] = true;

      try {
        for (const depName of (await depsOf(packageName))) {
          packagesToKeepLookup[depName] = true;
        }
      } catch (_e) {
        console.log(`PACKAGE-LOOKUP-DEPS: WARNING: error looking up deps for EXTERNAL(${ packageName }); ignoring`);
      }
    }
  };

  const packagesToRemove = Object.keys(await allPackages()).filter(packageName => packagesToKeepLookup[packageName] !== true);
  if (packagesToRemove.length > 0) {
    const removeCommand = `pacman -Rdd --noconfirm ${ packagesToRemove.join(" ") }`;
    console.log(`PACMAN-REMOVE-COMMAND: ${ removeCommand }`);
    //await passthru(removeCommand);
  }

  const allPackagesAfterChanges = await allPackages();

  for (const name of Object.keys(allPackagesAfterChanges)) {
    if (allPackagesBeforeChanges[name] == null) {
      console.log(`PACKAGE-INSTALLED: ${ name }@${ allPackagesAfterChanges[name] }`);
      changes.packages.added[name] = allPackagesAfterChanges[name];
    }
    if (allPackagesBeforeChanges[name] != null && allPackagesBeforeChanges[name] !== allPackagesAfterChanges[name]) {
      const from = allPackagesBeforeChanges[name];
      const to   = allPackagesAfterChanges[name];

      console.log(`PACKAGE-UPGRADED: ${ from } -> ${ to }`);
      changes.packages.updated[name] = { from, to };
    }
  }
  for (const name of Object.keys(allPackagesBeforeChanges)) {
    if (allPackagesAfterChanges[name] == null) {
      console.log(`PACKAGE-REMOVED: ${ name }@${ allPackagesBeforeChanges[name] }`);
      changes.packages.removed[name] = allPackagesBeforeChanges[name];
    }
  }

  systemstate.packages = allPackagesAfterChanges;
  await systemstate.save();
};
