# MLE Module Loader

This package is a script to download all dependencies for a given package. To use  
this you first need to install dependencies:

```bash
bun install
```

Once you have all the dependencies this program is run by the following call:

```bash
bun run index.ts -n <package name>
```

For example, to build a folder with all the `linkedom` dependencies, refer to  
the following example statement and subsequent output.

```bash
bun run index.ts -n linkedom
[INFO]: Found dependency list: linkedom@0.16.8,cssom@0.5.0,css-select@5.1.0,html-escaper@3.0.3,uhyphen@0.2.0,htmlparser2@9.1.0,boolbase@1.0.0,css-what@6.1.0,domutils@3.1.0,nth-check@2.1.1,domelementtype@2.3.0,domhandler@5.0.3,entities@4.5.0,dom-serializer@2.0.0
[WARN]: Additional module entities_decode needs be manually downloaded: https://cdn.jsdelivr.net/npm/entities@4.5.0/lib/decode.js/+esm
[INFO]: Scripts written to /tmp/linkedom-vdCPsc. Ready to compile to the DB
```

As outlined here, there are some packages that might not be picked up - such as  
the `entities` package contains a separate module path (as you see in the above  
output). The intention is to handle this, but we're not there yet.

If you navigate to the temporary file, you will find a bunch of SQL scripts:

1. _install.sql - designed to run all the generated SQL files
2. _remove.sql - wind back, removing all that was created
3. all the modules in SQL files

**important note:** Depending on the characters in the script, they may not compile  
correctly, and will require some manual intervention to tidy things up.
