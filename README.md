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

As outlined here, there are some packages that might not be picked up - such as  
the `entities` package contains a separate module path (as you see in the above  
output). The intention is to handle this, but we're not there yet.

If you navigate to the temporary folder that was printed out on the last line of  
output, you will find a bunch of SQL scripts:

1. _install.sql - designed to run all the generated SQL files
2. _remove.sql - wind back, removing all that was created
3. All the modules in SQL files
4. The environment which specifies all the import modules

**important note:** Depending on the characters in the script, they may not compile  
correctly, and will require some manual intervention to tidy things up.
