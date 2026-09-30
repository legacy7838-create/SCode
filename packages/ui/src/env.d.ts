/// <reference types="node" />

// UI is mainly based on the browser environment, and individual modules (such as logger's production judgment) will read process.env;
// The node type is explicitly introduced here to ensure that global declarations are not lost as dependencies change.
