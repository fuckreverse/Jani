if (typeof window === "undefined") {
    require('../../src/InputManager2');
    require(process.cwd()+'/inputs');
}


function foo(x) {
    if (x > 0) {
        return 1;
    } else {
        return -1;
    }
}

foo();
