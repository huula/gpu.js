const {
	utils
} = require('../utils');
const acorn = require('acorn');

/**
 *
 * @desc Represents a single function, inside JS, webGL, or openGL.
 * <p>This handles all the raw state, converted state, etc. Of a single function.</p>
 */
class FunctionNode {
	/**
	 *
	 * @param {string|object} source
	 * @param {IFunctionSettings} [settings]
	 */
	constructor(source, settings) {
		if (!source) {
			throw new Error('source parameter is missing');
		}
		settings = settings || {};

		this.source = source;
		this.name = typeof source === 'string' ? settings.isRootKernel ?
			'kernel' :
			(settings.name || utils.getFunctionNameFromString(source)) : null;
		this.calledFunctions = [];
		this.calledFunctionsArguments = {};
		this.constants = {};
		this.constantTypes = {};
		this.isRootKernel = false;
		this.isSubKernel = false;
		this.parent = null;
		this.debug = null;
		this.declarations = {};
		this.states = [];
		this.lookupReturnType = null;
		this.onNestedFunction = null;
		this.loopMaxIterations = null;
		this.argumentNames = (typeof this.source === 'string' ? utils.getArgumentNamesFromString(this.source) : null);
		this.argumentTypes = [];
		this.argumentSizes = [];
		this.returnType = null;
		this.output = [];
		this.plugins = null;

		if (settings) {
			for (const p in settings) {
				if (!settings.hasOwnProperty(p)) continue;
				if (!this.hasOwnProperty(p)) continue;
				this[p] = settings[p];
			}
		}

		if (!this.returnType) {
			this.returnType = 'Number';
		}

		this.validate();
		this._string = null;
		this._internalVariableNames = {};
	}

	validate() {
		if (typeof this.source !== 'string') {
			throw new Error('this.source not a string');
		}

		if (!utils.isFunctionString(this.source)) {
			throw new Error('this.source not a function string');
		}

		if (!this.name) {
			throw new Error('this.name could not be set');
		}

		if (this.argumentTypes.length > 0 && this.argumentTypes.length !== this.argumentNames.length) {
			throw new Error(`argumentTypes count of ${ this.argumentTypes.length } exceeds ${ this.argumentNames.length }`);
		}

		if (this.output.length < 1) {
			throw new Error('this.output is not big enough');
		}
	}

	/**
	 * @param {String} name
	 * @returns {boolean}
	 */
	isIdentifierConstant(name) {
		if (!this.constants) return false;
		return this.constants.hasOwnProperty(name);
	}

	isInput(argumentName) {
		return this.argumentTypes[this.argumentNames.indexOf(argumentName)] === 'Input';
	}

	pushState(state) {
		this.states.push(state);
	}

	popState(state) {
		if (this.state !== state) {
			throw new Error(`Cannot popState ${ state } when in ${ this.state }`);
		}
		this.states.pop();
	}

	isState(state) {
		return this.state === state;
	}

	get state() {
		return this.states[this.states.length - 1];
	}

	/**
	 * @function
	 * @name astMemberExpressionUnroll
	 * @desc Parses the abstract syntax tree for binary expression.
	 *
	 * <p>Utility function for astCallExpression.</p>
	 *
	 * @param {Object} ast - the AST object to parse
	 *
	 * @returns {String} the function namespace call, unrolled
	 */
	astMemberExpressionUnroll(ast) {
		if (ast.type === 'Identifier') {
			return ast.name;
		} else if (ast.type === 'ThisExpression') {
			return 'this';
		}

		if (ast.type === 'MemberExpression') {
			if (ast.object && ast.property) {
				//babel sniffing
				if (ast.object.hasOwnProperty('name') && ast.object.name[0] === '_') {
					return this.astMemberExpressionUnroll(ast.property);
				}

				return (
					this.astMemberExpressionUnroll(ast.object) +
					'.' +
					this.astMemberExpressionUnroll(ast.property)
				);
			}
		}

		//babel sniffing
		if (ast.hasOwnProperty('expressions')) {
			const firstExpression = ast.expressions[0];
			if (firstExpression.type === 'Literal' && firstExpression.value === 0 && ast.expressions.length === 2) {
				return this.astMemberExpressionUnroll(ast.expressions[1]);
			}
		}

		// Failure, unknown expression
		throw this.astErrorOutput('Unknown astMemberExpressionUnroll', ast);
	}

	/**
	 * @desc Parses the class function JS, and returns its Abstract Syntax Tree object.
	 * This is used internally to convert to shader code
	 *
	 * @param {Object} [inParser] - Parser to use, assumes in scope 'parser' if null or undefined
	 *
	 * @returns {Object} The function AST Object, note that result is cached under this.ast;
	 */
	getJsAST(inParser) {
		if (typeof this.source === 'object') {
			return this.ast = this.source;
		}

		inParser = inParser || acorn;
		if (inParser === null) {
			throw 'Missing JS to AST parser';
		}

		const ast = Object.freeze(inParser.parse(`const parser_${ this.name } = ${ this.source };`, {
			locations: true
		}));
		// take out the function object, outside the var declarations
		const functionAST = ast.body[0].declarations[0].init;
		if (!ast) {
			throw new Error('Failed to parse JS code');
		}

		return this.ast = functionAST;
	}

	/**
	 * @desc Return the type of parameter sent to subKernel/Kernel.
	 * @param {String} name - Name of the parameter
	 * @returns {String} Type of the parameter
	 */
	getVariableType(name) {
		let type = null;
		const argumentIndex = this.argumentNames.indexOf(name);
		if (argumentIndex === -1) {
			if (this.declarations[name]) {
				return this.declarations[name].type;
			}
		} else {
			const argumentType = this.argumentTypes[argumentIndex];
			if (argumentType) {
				type = argumentType;
			} else if (this.parent) {
				const calledFunctionArguments = this.parent.calledFunctionsArguments[this.name];
				for (let i = 0; i < calledFunctionArguments.length; i++) {
					const calledFunctionArgument = calledFunctionArguments[i];
					if (calledFunctionArgument[argumentIndex] !== null) {
						type = calledFunctionArgument[argumentIndex].type;
						this.argumentTypes[argumentIndex] = type;
						break;
					}
				}
			}
		}
		if (!type) {
			// TODO: strict type detection mode?
			// throw new Error(`Declaration of ${name} not found`);
		}
		return type;
	}

	getConstantType(constantName) {
		if (this.constantTypes[constantName]) {
			const type = this.constantTypes[constantName];
			if (type === 'Float') {
				return 'Number';
			} else {
				return type;
			}
		}
		return null;
	}

	/**
	 * @desc Return the name of the *user argument*(subKernel argument) corresponding
	 * to the argument supplied to the kernel
	 *
	 * @param {String} name - Name of the argument
	 * @returns {String} Name of the parameter
	 */
	getUserArgumentName(name) {
		const argumentIndex = this.argumentNames.indexOf(name);
		if (argumentIndex === -1) return null;
		if (!this.parent || this.isRootKernel) return null;
		const calledFunctionArguments = this.parent.calledFunctionsArguments[this.name];
		for (let i = 0; i < calledFunctionArguments.length; i++) {
			const calledFunctionArgument = calledFunctionArguments[i];
			const argument = calledFunctionArgument[argumentIndex];
			if (argument && argument.type !== 'Integer' && argument.type !== 'LiteralInteger' && argument.type !== 'Number') {
				return argument.name;
			}
		}
		return null;
	}

	toString() {
		if (this._string) return this._string;
		return this._string = this.astGeneric(this.getJsAST(), []).join('').trim();
	}

	toJSON() {
		const settings = {
			source: this.source,
			name: this.name,
			constants: this.constants,
			constantTypes: this.constantTypes,
			isRootKernel: this.isRootKernel,
			isSubKernel: this.isSubKernel,
			debug: this.debug,
			output: this.output,
			loopMaxIterations: this.loopMaxIterations,
			argumentNames: this.argumentNames,
			argumentTypes: this.argumentTypes,
			argumentSizes: this.argumentSizes,
			returnType: this.returnType
		};

		return {
			ast: this.ast,
			settings
		};
	}

	/**
	 * Recursively looks up type for ast expression until it's found
	 * @param ast
	 * @returns {string}
	 */
	getType(ast) {
		if (Array.isArray(ast)) {
			return this.getType(ast[ast.length - 1]);
		}
		switch (ast.type) {
			case 'BlockStatement':
				return this.getType(ast.body);
			case 'ArrayExpression':
				return `Array(${ ast.elements.length })`;
			case 'Literal':
				if (Number.isInteger(ast.value)) {
					return 'LiteralInteger';
				} else {
					return 'Number';
				}
			case 'CallExpression':
				if (this.isAstMathFunction(ast)) {
					return 'Number';
				}
				return ast.callee && ast.callee.name && this.lookupReturnType ? this.lookupReturnType(ast.callee.name) : null;
			case 'BinaryExpression':
				// modulos is Number
				if (ast.operator === '%') {
					return 'Number';
				} else if (ast.operator === '>' || ast.operator === '<') {
					return 'Boolean';
				}
				const type = this.getType(ast.left);
				return typeLookupMap[type] || type;
			case 'UpdateExpression':
				return this.getType(ast.argument);
			case 'UnaryExpression':
				return this.getType(ast.argument);
			case 'VariableDeclaration':
				return this.getType(ast.declarations[0]);
			case 'VariableDeclarator':
				return this.getType(ast.id);
			case 'Identifier':
				if (this.isAstVariable(ast)) {
					const signature = this.getVariableSignature(ast);
					if (signature === 'value') {
						if (this.argumentNames.indexOf(ast.name) > -1) {
							return this.getVariableType(ast.name);
						} else if (this.declarations[ast.name]) {
							return this.declarations[ast.name].type;
						}
					}
				}
				if (ast.name === 'Infinity') {
					return 'Integer';
				}
				return null;
			case 'ReturnStatement':
				return this.getType(ast.argument);
			case 'MemberExpression':
				if (this.isAstMathFunction(ast)) {
					switch (ast.property.name) {
						case 'ceil':
							return 'Integer';
						case 'floor':
							return 'Integer';
						case 'round':
							return 'Integer';
					}
					return 'Number';
				}
				if (this.isAstVariable(ast)) {
					const variableSignature = this.getVariableSignature(ast);
					switch (variableSignature) {
						case 'value[]':
							return typeLookupMap[this.getVariableType(ast.object.name)];
						case 'value[][]':
							return typeLookupMap[this.getVariableType(ast.object.object.name)];
						case 'value[][][]':
							return typeLookupMap[this.getVariableType(ast.object.object.object.name)];
						case 'this.thread.value':
							return 'Integer';
						case 'this.output.value':
							return 'Integer';
						case 'this.constants.value':
							return this.getConstantType(ast.property.name);
						case 'this.constants.value[]':
							return typeLookupMap[this.getConstantType(ast.object.property.name)];
						case 'this.constants.value[][]':
							return typeLookupMap[this.getConstantType(ast.object.object.property.name)];
						case 'this.constants.value[][][]':
							return typeLookupMap[this.getConstantType(ast.object.object.object.property.name)];
						case 'fn()[]':
							return typeLookupMap[this.getType(ast.object)];
						case 'fn()[][]':
							return typeLookupMap[this.getType(ast.object)];
						case 'fn()[][][]':
							return typeLookupMap[this.getType(ast.object)];
						case 'value.value':
							if (this.isAstMathVariable(ast)) {
								return 'Number';
							}
							switch (ast.property.name) {
								case 'r':
									return typeLookupMap[this.getVariableType(ast.object.name)];
								case 'g':
									return typeLookupMap[this.getVariableType(ast.object.name)];
								case 'b':
									return typeLookupMap[this.getVariableType(ast.object.name)];
								case 'a':
									return typeLookupMap[this.getVariableType(ast.object.name)];
							}
					}
					throw this.astErrorOutput('Unhandled getType MemberExpression', ast);
				}
				throw this.astErrorOutput('Unhandled getType MemberExpression', ast);
			case 'FunctionDeclaration':
				return this.getType(ast.body);
			case 'ConditionalExpression':
				return this.getType(ast.consequent);
			default:
				throw this.astErrorOutput(`Unhandled getType Type "${ ast.type }"`, ast);
		}
	}

	isAstMathVariable(ast) {
		const mathProperties = [
			'E',
			'PI',
			'SQRT2',
			'SQRT1_2',
			'LN2',
			'LN10',
			'LOG2E',
			'LOG10E',
		];
		return ast.type === 'MemberExpression' &&
			ast.object && ast.object.type === 'Identifier' &&
			ast.object.name === 'Math' &&
			ast.property &&
			ast.property.type === 'Identifier' &&
			mathProperties.indexOf(ast.property.name) > -1;
	}

	isAstMathFunction(ast) {
		const mathFunctions = [
			'abs',
			'acos',
			'asin',
			'atan',
			'atan2',
			'ceil',
			'cos',
			'exp',
			'floor',
			'log',
			'log2',
			'max',
			'min',
			'pow',
			'random',
			'round',
			'sign',
			'sin',
			'sqrt',
			'tan',
		];
		return ast.type === 'CallExpression' &&
			ast.callee &&
			ast.callee.type === 'MemberExpression' &&
			ast.callee.object &&
			ast.callee.object.type === 'Identifier' &&
			ast.callee.object.name === 'Math' &&
			ast.callee.property &&
			ast.callee.property.type === 'Identifier' &&
			mathFunctions.indexOf(ast.callee.property.name) > -1;
	}

	isAstVariable(ast) {
		return ast.type === 'Identifier' || ast.type === 'MemberExpression';
	}

	isSafe(ast) {
		return this.isSafeDependencies(this.getDependencies(ast));
	}

	isSafeDependencies(dependencies) {
		return dependencies && dependencies.every ? dependencies.every(dependency => dependency.isSafe) : true;
	}

	getDependencies(ast, dependencies, isNotSafe) {
		if (!dependencies) {
			dependencies = [];
		}
		if (!ast) return null;
		if (Array.isArray(ast)) {
			for (let i = 0; i < ast.length; i++) {
				this.getDependencies(ast[i], dependencies, isNotSafe);
			}
			return dependencies;
		}
		switch (ast.type) {
			case 'Literal':
				dependencies.push({
					origin: 'literal',
					value: ast.value,
					isSafe: isNotSafe === true ? false : ast.value > -Infinity && ast.value < Infinity && !isNaN(ast.value)
				});
				break;
			case 'VariableDeclarator':
				return this.getDependencies(ast.init, dependencies, isNotSafe);
			case 'Identifier':
				if (this.declarations[ast.name]) {
					dependencies.push({
						name: ast.name,
						origin: 'declaration',
						isSafe: isNotSafe ? false : this.isSafeDependencies(this.declarations[ast.name].dependencies),
					});
				} else if (this.argumentNames.indexOf(ast.name) > -1) {
					dependencies.push({
						name: ast.name,
						origin: 'argument',
						isSafe: false,
					});
				}
				break;
			case 'FunctionDeclaration':
				return this.getDependencies(ast.body.body[ast.body.body.length - 1], dependencies, isNotSafe);
			case 'ReturnStatement':
				return this.getDependencies(ast.argument, dependencies);
			case 'BinaryExpression':
				isNotSafe = (ast.operator === '/' || ast.operator === '*');
				this.getDependencies(ast.left, dependencies, isNotSafe);
				this.getDependencies(ast.right, dependencies, isNotSafe);
				return dependencies;
			case 'UpdateExpression':
				return this.getDependencies(ast.argument, dependencies, isNotSafe);
			case 'VariableDeclaration':
				return this.getDependencies(ast.declarations, dependencies, isNotSafe);
			case 'ArrayExpression':
				dependencies.push({
					origin: 'declaration',
					isSafe: true,
				});
				return dependencies;
			case 'CallExpression':
				dependencies.push({
					origin: 'function',
					isSafe: true,
				});
				return dependencies;
			case 'MemberExpression':
				const details = this.getMemberExpressionDetails(ast);
				if (details) {
					return details.type;
				}
			default:
				throw this.astErrorOutput(`Unhandled type ${ ast.type } in getAllVariables`, ast);
		}
		return dependencies;
	}

	getVariableSignature(ast) {
		if (!this.isAstVariable(ast)) {
			throw new Error(`ast of type "${ ast.type }" is not a variable signature`);
		}
		if (ast.type === 'Identifier') {
			return 'value';
		}
		const signature = [];
		while (true) {
			if (!ast) break;
			if (ast.computed) {
				signature.push('[]');
			} else if (ast.type === 'ThisExpression') {
				signature.unshift('this');
			} else if (ast.property && ast.property.name) {
				if (
					ast.property.name === 'x' ||
					ast.property.name === 'y' ||
					ast.property.name === 'z'
				) {
					signature.unshift('.value');
				} else if (
					ast.property.name === 'constants' ||
					ast.property.name === 'thread' ||
					ast.property.name === 'output'
				) {
					signature.unshift('.' + ast.property.name);
				} else {
					signature.unshift('.value');
				}
			} else if (ast.name) {
				signature.unshift('value');
			} else if (ast.callee && ast.callee.name) {
				signature.unshift('fn()');
			} else {
				signature.unshift('unknown');
			}
			ast = ast.object;
		}

		const signatureString = signature.join('');
		const allowedExpressions = [
			'value',
			'value[]',
			'value[][]',
			'value[][][]',
			'value.value',
			'this.thread.value',
			'this.output.value',
			'this.constants.value',
			'this.constants.value[]',
			'this.constants.value[][]',
			'this.constants.value[][][]',
			'fn()[]',
			'fn()[][]',
			'fn()[][][]',
		];
		if (allowedExpressions.indexOf(signatureString) > -1) {
			return signatureString;
		}
		return null;
	}

	build() {
		return this.toString().length > 0;
	}

	/**
	 * @desc Parses the abstract syntax tree for generically to its respective function
	 * @param {Object} ast - the AST object to parse
	 * @param {Array} retArr - return array string
	 * @returns {Array} the parsed string array
	 */
	astGeneric(ast, retArr) {
		if (ast === null) {
			throw this.astErrorOutput('NULL ast', ast);
		} else {
			if (Array.isArray(ast)) {
				for (let i = 0; i < ast.length; i++) {
					this.astGeneric(ast[i], retArr);
				}
				return retArr;
			}

			switch (ast.type) {
				case 'FunctionDeclaration':
					return this.astFunctionDeclaration(ast, retArr);
				case 'FunctionExpression':
					return this.astFunctionExpression(ast, retArr);
				case 'ReturnStatement':
					return this.astReturnStatement(ast, retArr);
				case 'Literal':
					return this.astLiteral(ast, retArr);
				case 'BinaryExpression':
					return this.astBinaryExpression(ast, retArr);
				case 'Identifier':
					return this.astIdentifierExpression(ast, retArr);
				case 'AssignmentExpression':
					return this.astAssignmentExpression(ast, retArr);
				case 'ExpressionStatement':
					return this.astExpressionStatement(ast, retArr);
				case 'EmptyStatement':
					return this.astEmptyStatement(ast, retArr);
				case 'BlockStatement':
					return this.astBlockStatement(ast, retArr);
				case 'IfStatement':
					return this.astIfStatement(ast, retArr);
				case 'BreakStatement':
					return this.astBreakStatement(ast, retArr);
				case 'ContinueStatement':
					return this.astContinueStatement(ast, retArr);
				case 'ForStatement':
					return this.astForStatement(ast, retArr);
				case 'WhileStatement':
					return this.astWhileStatement(ast, retArr);
				case 'DoWhileStatement':
					return this.astDoWhileStatement(ast, retArr);
				case 'VariableDeclaration':
					return this.astVariableDeclaration(ast, retArr);
				case 'VariableDeclarator':
					return this.astVariableDeclarator(ast, retArr);
				case 'ThisExpression':
					return this.astThisExpression(ast, retArr);
				case 'SequenceExpression':
					return this.astSequenceExpression(ast, retArr);
				case 'UnaryExpression':
					return this.astUnaryExpression(ast, retArr);
				case 'UpdateExpression':
					return this.astUpdateExpression(ast, retArr);
				case 'LogicalExpression':
					return this.astLogicalExpression(ast, retArr);
				case 'MemberExpression':
					return this.astMemberExpression(ast, retArr);
				case 'CallExpression':
					return this.astCallExpression(ast, retArr);
				case 'ArrayExpression':
					return this.astArrayExpression(ast, retArr);
				case 'DebuggerStatement':
					return this.astDebuggerStatement(ast, retArr);
				case 'ConditionalExpression':
					return this.astConditionalExpression(ast, retArr);
			}

			throw this.astErrorOutput('Unknown ast type : ' + ast.type, ast);
		}
	}
	/**
	 * @desc To throw the AST error, with its location.
	 * @param {string} error - the error message output
	 * @param {Object} ast - the AST object where the error is
	 */
	astErrorOutput(error, ast) {
		if (typeof this.source !== 'string') {
			return new Error(error);
		}

		const debugString = utils.getAstString(this.source, ast);
		const leadingSource = this.source.substr(ast.start);
		const splitLines = leadingSource.split(/\n/);
		const lineBefore = splitLines.length > 0 ? splitLines[splitLines.length - 1] : 0;
		return new Error(`${error} on line ${ splitLines.length }, position ${ lineBefore.length }:\n ${ debugString }`);
	}

	astDebuggerStatement(arrNode, retArr) {
		return retArr;
	}

	astConditionalExpression(ast, retArr) {
		if (ast.type !== 'ConditionalExpression') {
			throw this.astErrorOutput('Not a conditional expression', ast);
		}
		retArr.push('(');
		this.astGeneric(ast.test, retArr);
		retArr.push('?');
		this.astGeneric(ast.consequent, retArr);
		retArr.push(':');
		this.astGeneric(ast.alternate, retArr);
		retArr.push(')');
		return retArr;
	}
	/**
	 * @desc Parses the abstract syntax tree for to its *named function declaration*
	 * @param {Object} ast - the AST object to parse
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astFunctionDeclaration(ast, retArr) {
		if (this.onNestedFunction) {
			let returnType = this.getType(ast);
			if (returnType === 'LiteralInteger') {
				returnType = 'Number';
			}
			this.onNestedFunction(utils.getAstString(this.source, ast), returnType);
		}
		return retArr;
	}
	astFunctionExpression(ast, retArr) {
		return retArr;
	}
	astReturnStatement(ast, retArr) {
		return retArr;
	}
	astLiteral(ast, retArr) {
		return retArr;
	}
	astBinaryExpression(ast, retArr) {
		return retArr;
	}
	astIdentifierExpression(ast, retArr) {
		return retArr;
	}
	astAssignmentExpression(ast, retArr) {
		return retArr;
	}
	/**
	 * @desc Parses the abstract syntax tree for *generic expression* statement
	 * @param {Object} esNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astExpressionStatement(esNode, retArr) {
		this.astGeneric(esNode.expression, retArr);
		retArr.push(';');
		return retArr;
	}
	/**
	 * @desc Parses the abstract syntax tree for an *Empty* Statement
	 * @param {Object} eNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astEmptyStatement(eNode, retArr) {
		return retArr;
	}
	astBlockStatement(ast, retArr) {
		return retArr;
	}
	astIfStatement(ast, retArr) {
		return retArr;
	}
	/**
	 * @desc Parses the abstract syntax tree for *Break* Statement
	 * @param {Object} brNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astBreakStatement(brNode, retArr) {
		retArr.push('break;');
		return retArr;
	}
	/**
	 * @desc Parses the abstract syntax tree for *Continue* Statement
	 * @param {Object} crNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astContinueStatement(crNode, retArr) {
		retArr.push('continue;\n');
		return retArr;
	}
	astForStatement(ast, retArr) {
		return retArr;
	}
	astWhileStatement(ast, retArr) {
		return retArr;
	}
	astDoWhileStatement(ast, retArr) {
		return retArr;
	}
	/**
	 * @desc Parses the abstract syntax tree for *Variable Declaration*
	 * @param {Object} varDecNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astVariableDeclaration(varDecNode, retArr) {
		const declarations = varDecNode.declarations;
		if (!declarations || !declarations[0] || !declarations[0].init) {
			throw this.astErrorOutput('Unexpected expression', varDecNode);
		}
		const result = [];
		const firstDeclaration = declarations[0];
		const init = firstDeclaration.init;
		let type = this.isState('in-for-loop-init') ? 'Integer' : this.getType(init);
		if (type === 'LiteralInteger') {
			// We had the choice to go either float or int, choosing float
			type = 'Number';
		}
		const markupType = typeMap[type];
		if (!markupType) {
			throw this.astErrorOutput(`Markup type ${ markupType } not handled`, varDecNode);
		}
		let dependencies = this.getDependencies(firstDeclaration.init);
		this.declarations[firstDeclaration.id.name] = Object.freeze({
			type,
			dependencies,
			isSafe: dependencies.every(dependency => dependency.isSafe)
		});
		const initResult = [`${type} user_${firstDeclaration.id.name}=`];
		this.astGeneric(init, initResult);
		result.push(initResult.join(''));

		// first declaration is done, now any added ones setup
		for (let i = 1; i < declarations.length; i++) {
			const declaration = declarations[i];
			dependencies = this.getDependencies(declaration);
			this.declarations[declaration.id.name] = Object.freeze({
				type,
				dependencies,
				isSafe: false
			});
			this.astGeneric(declaration, result);
		}

		retArr.push(retArr, result.join(','));
		retArr.push(';');
		return retArr;
	}
	/**
	 * @desc Parses the abstract syntax tree for *Variable Declarator*
	 * @param {Object} iVarDecNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astVariableDeclarator(iVarDecNode, retArr) {
		this.astGeneric(iVarDecNode.id, retArr);
		if (iVarDecNode.init !== null) {
			retArr.push('=');
			this.astGeneric(iVarDecNode.init, retArr);
		}
		return retArr;
	}
	astThisExpression(ast, retArr) {
		return retArr;
	}
	astSequenceExpression(sNode, retArr) {
		for (let i = 0; i < sNode.expressions.length; i++) {
			if (i > 0) {
				retArr.push(',');
			}
			this.astGeneric(sNode.expressions, retArr);
		}
		return retArr;
	}
	/**
	 * @desc Parses the abstract syntax tree for *Unary* Expression
	 * @param {Object} uNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astUnaryExpression(uNode, retArr) {
		if (uNode.prefix) {
			retArr.push(uNode.operator);
			this.astGeneric(uNode.argument, retArr);
		} else {
			this.astGeneric(uNode.argument, retArr);
			retArr.push(uNode.operator);
		}

		return retArr;
	}
	/**
	 * @desc Parses the abstract syntax tree for *Update* Expression
	 * @param {Object} uNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astUpdateExpression(uNode, retArr) {
		if (uNode.prefix) {
			retArr.push(uNode.operator);
			this.astGeneric(uNode.argument, retArr);
		} else {
			this.astGeneric(uNode.argument, retArr);
			retArr.push(uNode.operator);
		}

		return retArr;
	}
	/**
	 * @desc Parses the abstract syntax tree for *Logical* Expression
	 * @param {Object} logNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astLogicalExpression(logNode, retArr) {
		retArr.push('(');
		this.astGeneric(logNode.left, retArr);
		retArr.push(logNode.operator);
		this.astGeneric(logNode.right, retArr);
		retArr.push(')');
		return retArr;
	}
	astMemberExpression(ast, retArr) {
		return retArr;
	}
	astCallExpression(ast, retArr) {
		return retArr;
	}
	astArrayExpression(ast, retArr) {
		return retArr;
	}

	getMemberExpressionDetails(ast) {
		if (ast.type !== 'MemberExpression') {
			throw this.astErrorOutput(`Expression ${ ast.type } not a MemberExpression`, ast);
		}
		let name = null;
		let type = null;
		const variableSignature = this.getVariableSignature(ast);
		switch (variableSignature) {
			case 'value':
				return null;
			case 'this.thread.value':
			case 'this.output.value':
				return {
					signature: variableSignature,
					type: 'Integer',
					name: ast.property.name
				};
			case 'value[]':
				if (typeof ast.object.name !== 'string') {
					throw this.astErrorOutput('Unexpected expression', ast);
				}
				name = ast.object.name;
				return {
					name,
					origin: 'user',
					signature: variableSignature,
					type: this.getVariableType(name),
					xProperty: ast.property
				};
			case 'value[][]':
				if (typeof ast.object.object.name !== 'string') {
					throw this.astErrorOutput('Unexpected expression', ast);
				}
				name = ast.object.object.name;
				return {
					name,
					origin: 'user',
					signature: variableSignature,
					type: this.getVariableType(name),
					yProperty: ast.object.property,
					xProperty: ast.property,
				};
			case 'value[][][]':
				if (typeof ast.object.object.object.name !== 'string') {
					throw this.astErrorOutput('Unexpected expression', ast);
				}
				name = ast.object.object.object.name;
				return {
					name,
					origin: 'user',
					signature: variableSignature,
					type: this.getVariableType(name),
					zProperty: ast.object.object.property,
					yProperty: ast.object.property,
					xProperty: ast.property,
				};
			case 'value.value':
				if (typeof ast.property.name !== 'string') {
					throw this.astErrorOutput('Unexpected expression', ast);
				}
				if (this.isAstMathVariable(ast)) {
					name = ast.property.name;
					return {
						name,
						origin: 'Math',
						type: 'Number',
						signature: variableSignature,
					};
				}
				switch (ast.property.name) {
					case 'r':
					case 'g':
					case 'b':
					case 'a':
						name = ast.object.name;
						return {
							name,
							property: ast.property.name,
							origin: 'user',
							signature: variableSignature,
							type: 'Number'
						};
					default:
						throw this.astErrorOutput('Unexpected expression', ast);
				}
			case 'this.constants.value':
				if (typeof ast.property.name !== 'string') {
					throw this.astErrorOutput('Unexpected expression', ast);
				}
				name = ast.property.name;
				type = this.getConstantType(name);
				if (!type) {
					throw this.astErrorOutput('Constant has no type', ast);
				}
				return {
					name,
					type,
					origin: 'constants',
					signature: variableSignature,
				};
			case 'this.constants.value[]':
				if (typeof ast.object.property.name !== 'string') {
					throw this.astErrorOutput('Unexpected expression', ast);
				}
				name = ast.object.property.name;
				type = this.getConstantType(name);
				if (!type) {
					throw this.astErrorOutput('Constant has no type', ast);
				}
				return {
					name,
					type,
					origin: 'constants',
					signature: variableSignature,
					xProperty: ast.property,
				};
			case 'this.constants.value[][]':
				{
					if (typeof ast.object.object.property.name !== 'string') {
						throw this.astErrorOutput('Unexpected expression', ast);
					}
					name = ast.object.object.property.name;
					type = this.getConstantType(name);
					if (!type) {
						throw this.astErrorOutput('Constant has no type', ast);
					}
					return {
						name,
						type,
						origin: 'constants',
						signature: variableSignature,
						yProperty: ast.object.property,
						xProperty: ast.property,
					};
				}
			case 'this.constants.value[][][]':
				{
					if (typeof ast.object.object.object.property.name !== 'string') {
						throw this.astErrorOutput('Unexpected expression', ast);
					}
					name = ast.object.object.object.property.name;
					type = this.getConstantType(name);
					if (!type) {
						throw this.astErrorOutput('Constant has no type', ast);
					}
					return {
						name,
						type,
						origin: 'constants',
						signature: variableSignature,
						zProperty: ast.object.object.property,
						yProperty: ast.object.property,
						xProperty: ast.property,
					};
				}
			case 'fn()[]':
				return {
					signature: variableSignature,
					property: ast.property
				};
			default:
				throw this.astErrorOutput('Unexpected expression', ast);
		}
	}

	getInternalVariableName(name) {
		if (!this._internalVariableNames.hasOwnProperty(name)) {
			this._internalVariableNames[name] = 0;
		}
		this._internalVariableNames[name]++;
		if (this._internalVariableNames[name] === 1) {
			return name;
		}
		return name + this._internalVariableNames[name];
	}
}

const typeLookupMap = {
	'Array': 'Number',
	'Array(2)': 'Number',
	'Array(3)': 'Number',
	'Array(4)': 'Number',
	'Array2D': 'Number',
	'Array3D': 'Number',
	'HTMLImage': 'Array(4)',
	'HTMLImageArray': 'Array(4)',
	'NumberTexture': 'Number',
	'ArrayTexture(4)': 'Array(4)',
};

module.exports = {
	FunctionNode
};