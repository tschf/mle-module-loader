# MLE Module Loader

This package is a program to download all dependencies for a given package. To use  
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
[INFO]: Found dependency list: linkedom@0.16.8,html-escaper@3.0.3,htmlparser2@9.1.0,cssom@0.5.0,css-select@5.1.0,uhyphen@0.2.0,domhandler@5.0.3,domelementtype@2.3.0,domutils@3.1.0,entities@4.5.0,boolbase@1.0.0,css-what@6.1.0,nth-check@2.1.1,dom-serializer@2.0.0
[INFO]: Run /tmp/linkedom-FzZN8E/install.sql in SQLcl to compile MLE objects to the database.
```

If you navigate to the temporary folder that was printed out on the last line of  
output, you will find a bunch of SQL scripts:

1. install.sql - designed to run all the generated SQL files
2. remove.sql - wind back, removing all that was created
3. moduleLoader.js - JavaScript code that can be run in SQLcl that loads data to a table
4. All the modules JS - replacing module references so they are imported correctly
5. The environment which specifies all the import modules
