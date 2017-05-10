import Trace from '../src/Trace';
import { Assembler, VM, default as whynot } from '../src/index';

import regexParser from './util/regexParser';

import * as chai from 'chai';

describe('whynot.js examples', () => {
	// All whynot VMs expect to receive their input through a function that returns the
	// items one by one. The function should return null to indicate the end of input.
	// Here's a simple helper which creates this iterator based on a string or array:
	function createInput (input: {[key: number]: string}): () => string | null {
		let i = 0;
		return () => {
			return input[i++] || null;
		};
	}

	// whynot.js was designed to answer the question of *why* a given input does not match
	// a given grammar. It can sometimes even tell you how to extend the input so that it
	// will match. To illustrate this, consider a simple subset of regular expressions.
	describe('regular expressions', () => {
		// We have generated a very simple parser using PEG.js for the subset of regular
		// expressions consisting of character matches (a-z, lower case), sequences,
		// choices ("|") and grouping using parentheses ("(" and ")"). This will create
		// an AST as a set of nested arrays, starting with the type of AST node, followed
		// by its children.
		// The compile function traverses the AST recursively and generates a whynot
		// program using the provided assembler.
		function compile (assembler: Assembler<string>, ast: any[], recordMissing: boolean) {
			let i: number;
			const l = ast.length;
			switch (ast[0]) {
				case 'test':
					// A test represents an expected character, e.g., /a/
					if (!recordMissing) {
						// Normally, it is simply represented by a test instruction which
						// fails if the input character is not the expected character.
						assembler.test(function (input: string): boolean { 
							return input == ast[1]; 
						});
					} 
					else {
						// To record missing characters, we add a branch for each allowing
						// the VM to skip the character. In both cases, we use a record
						// instruction to remember the character when it is processed.
						assembler.record(ast[1]);
						const skipTest = assembler.jump([]);
						// Branch for existing character
						skipTest.data.push(assembler.program.length);
						assembler.test(function (input: string): boolean { 
							return input == ast[1]; 
						});
						const skipBad = assembler.jump([]);
						// Branch for missing character
						skipTest.data.push(assembler.program.length);
						// Prefer the branch where the character exists
						assembler.bad();
						// Join both branches to continue execution
						skipBad.data.push(assembler.program.length);
					}
					return;

				case 'seq':
					// A sequence of characters and/or groups, e.g., /abc/
					// This is represented in the program by simply executing its parts in
					// the specified order.
					for (i = 1; i < l; ++i) {
						compile(assembler, ast[i], recordMissing);
					}
					return;

				case 'choice': {
					// Alternatives, e.g., /a|b|c/
					// These are represented in the VM by forking execution to all options
					// in parallel and merging the surviving threads afterwards.
					const fork = assembler.jump([]);
					const joins = [];
					for (i = 1; i < l; ++i) {
						fork.data.push(assembler.program.length);
						compile(assembler, ast[i], recordMissing);
						joins.push(assembler.jump([]));
					}
					joins.forEach (join => {
						join.data.push(assembler.program.length);
					});
					return;
				}
			}
		}

		// We can now define a simple helper to glue everything together
		function compileRegexVM (regex: string, recordMissing: boolean): VM<string> {
			// Use the generated parser for a quick AST
			const ast = regexParser.parse(regex);

			// Compile the AST into a whynot VM
			return whynot.compileVM(assembler => {
				compile(assembler, ast, recordMissing);
				// Any threads that made it to the end of the program have successfully
				// matched the complete input and can be accepted.
				assembler.accept();
			});
		}

		// One more quick helper to pull full strings out of the trace trees generated by
		// the VM when it is recording its progression.
		function flattenRecordStrings (traces: Trace[], head: string[] = [], flatRecords: string[] = []) {
			chai.expect(traces).to.be.an.instanceOf(Array);

			// Generate combined strings for each trace in the array
			for (let i = 0, l = traces.length; i < l; ++i) {
				const trace = traces[i];

				// Combine the records found so far with those of this trace
				const combinedHead = trace.records.concat(head);

				if (!trace.prefixes.length) {
					// Beginning of trace reached, add full record string
					flatRecords.push(combinedHead.join(''));
				} 
				else {
					// Recurse into prefixes
					flattenRecordStrings(trace.prefixes, combinedHead, flatRecords);
				}
			}
			return flatRecords;
		}

		it('can perform simple matching', () => {
			// If a VM can detect how to fix a string, it should first be able to tell if
			// it was broken in the first place. Executing the plain program should do
			// just that. If it returns any traces, these represent how the program was
			// able to match the input. If it doesn't, the input did not match in any way.
			const vm = compileRegexVM('abc(d|e)f', false);

			// This regex should match the string 'abcdf'
			const matchingResult = vm.execute(createInput('abcdf'));
			chai.expect(matchingResult.success).to.equal(true);
			chai.expect(matchingResult.acceptingTraces.length).to.equal(1);

			// But it won't match the string 'abcf'
			const failingResult = vm.execute(createInput('abcf'));
			chai.expect(failingResult.success).to.equal(false);
			chai.expect(failingResult.acceptingTraces.length).to.equal(0);
			// It will, however, return the last failing traces
			chai.expect(failingResult.failingTraces.length).to.equal(2);
		});

		it('can complete a string based on a regex', () => {
			// The real fun starts when you add the additional instructions to allow and
			// detect missing characters. Now the traces returned by the VM can tell you
			// how to fix the input, provided it can be fixed by adding more characters.
			const vm = compileRegexVM('(a|(bc))d(e|f)', true);
			// There are a few branches in this regex, we get different results based on
			// which choices we remove by adding characters to the input.
			// For instance, 'ad' fixes the first choice but not the second, so we get two
			// results:
			chai.expect(flattenRecordStrings(vm.execute(createInput('ad')).acceptingTraces))
				.to.deep.equal(['ade', 'adf']);
			// Fixing both choices yields only a single result:
			chai.expect(flattenRecordStrings(vm.execute(createInput('bf')).acceptingTraces))
				.to.deep.equal(['bcdf']);
			// While leaving both open generates all strings accepted by the regex:
			chai.expect(flattenRecordStrings(vm.execute(createInput('d')).acceptingTraces))
				.to.deep.equal(['ade', 'bcde', 'adf', 'bcdf']);
			// Finally, presenting an input which can not be made to match by adding
			// characters yields no results:
			chai.expect(flattenRecordStrings(vm.execute(createInput('abc')).acceptingTraces))
				.to.deep.equal([]);
		});
	});

	// As well as telling you why a string does not match a certain language,
	// whynot.js can, to an extend, predict extensions to the inputted string also matching the language
	describe('regular expression exploration', () => {
		// We have generated a very simple parser using PEG.js for the subset of regular
		// expressions consisting of character matches (a-z, lower case), sequences,
		// choices ("|"), Kleene star ("*") and grouping using parentheses ("(" and ")"). This will create
		// an AST as a set of nested arrays, starting with the type of AST node, followed
		// by its children.
		// The compile function traverses the AST recursively and generates a whynot
		// program using the provided assembler.
		function compile (assembler: Assembler<string>, ast: any[], recordingMode: boolean) {
			let i: number;
			const l = ast.length;
			switch (ast[0]) {
				case 'test':
					// A test represents an expected character, e.g., /a/
					if (!recordingMode) {
						// Normally, it is simply represented by a test instruction which
						// fails if the input character is not the expected character.
						assembler.test(function(input) { return input == ast[1]; });
						assembler.record(
							null,
							() => {
								return {
									isExploration: false,
									input: ast[1]
								};
							});
					}
					else {
						assembler.record(
							null,
							() => {
								return {
									isExploration: true,
									input: ast[1]
								};
							});
					}
					return;

				case 'seq':
					// A sequence of characters and/or groups, e.g., /abc/
					// This is represented in the program by simply executing its parts in
					// the specified order.
					for (i = 1; i < l; ++i) {
						compile(assembler, ast[i], recordingMode);
					}
					return;

				case 'choice': {
					// Alternatives, e.g., /a|b|c/
					// These are represented in the VM by forking execution to all options
					// in parallel and merging the surviving threads afterwards.
					const fork = assembler.jump([]);
					const joins = [];
					for (i = 1; i < l; ++i) {
						fork.data.push(assembler.program.length);
						compile(assembler, ast[i], recordingMode);
						joins.push(assembler.jump([]));
					}
					joins.forEach(join => {
						join.data.push(assembler.program.length);
					});
					return;
				}

				case 'repetition':
					// Kleene star: Unbounded Repetition, e.g., /a*/
					// These are represented in the VM by looping over them.

					if (!recordingMode) {
						// For exploration, they are:
						//  - a recording part
						//  - a testing part, providing a return
						//  - another recording part.
						//  - A jump back to the first testing part

						// Record the possible insertion of this character at 0
						compile(assembler, ast[1], true);

						const start = assembler.program.length;
						const join = assembler.jump([]);
						join.data.push(assembler.program.length);

						// Test for the existing character at n
						compile(assembler, ast[1], recordingMode);

						// Record the possible insertion at n + 1
						compile(assembler, ast[1], true);

						assembler.jump([start]);

						join.data.push(assembler.program.length);

						return;
					}

					// In recording mode, the recording of a* is the same as the recording of a single a.
					// this optimizes the program length of a language with star height > 1 significantly.
					compile(assembler, ast[1], true);
			}
		}

		// We can now define a simple helper to glue everything together
		function compileRegexVM (regex: string, recordMissing: boolean): VM<string> {
			// Use the generated parser for a quick AST
			const ast = regexParser.parse(regex);

			// Compile the AST into a whynot VM
			return whynot.compileVM(assembler => {
				compile(assembler, ast, recordMissing);
				// Any threads that made it to the end of the program have successfully
				// matched the complete input and can be accepted.
				assembler.accept();
			});
		}

		// One more quick helper to pull full strings out of the trace trees generated by
		// the VM when it is recording its progression.
		function flattenRecordStrings (traces: Trace[], head: string[] = [], flatRecords: string[] = []) {
			chai.expect(traces).to.be.an.instanceOf(Array);

			function transformRecord (record: any): string {
				return record.isExploration ? '[' + record.input + ']' : record.input;
			}

			// Generate combined strings for each trace in the array
			for (let i = 0, l = traces.length; i < l; ++i) {
				const trace = traces[i];

				// Combine the records found so far with those of this trace
				const combinedHead = trace.records.concat(head);

				if (!trace.prefixes.length) {
					// Beginning of trace reached, add full record string
					flatRecords.push(combinedHead.map(transformRecord).join(''));
				}
				else {
					// Recurse into prefixes
					flattenRecordStrings(trace.prefixes, combinedHead, flatRecords);
				}
			}
			return flatRecords;
		}

		it('can specify possible extensions to the inputted string of length 1', () => {
			// If a VM can detect how to fix a string, it should first be able to tell if
			// it was broken in the first place. Executing the plain program should do
			// just that. If it returns any traces, these represent how the program was
			// able to match the input. If it doesn't, the input did not match in any way.
			const vm = compileRegexVM('(a|b)*', false);

			// This regex should match the string 'a', and generate extensions '[a]a[a]', '[b]a[a]', '[a]a[b]', '[b]a[b]'
			const matchingResult = vm.execute(createInput('a'));
			chai.expect(matchingResult.success).to.equal(true);
			chai.expect(matchingResult.acceptingTraces.length).to.equal(1);

			chai.expect(flattenRecordStrings(matchingResult.acceptingTraces)).to.deep.equal([
				'[a]a[a]', '[b]a[a]', '[a]a[b]', '[b]a[b]'
			]);
		});

		it('can specify possible extensions to the inputted string of length 2', () => {
			// If a VM can detect how to fix a string, it should first be able to tell if
			// it was broken in the first place. Executing the plain program should do
			// just that. If it returns any traces, these represent how the program was
			// able to match the input. If it doesn't, the input did not match in any way.
			const vm = compileRegexVM('(a|b)*', false);

			// This regex should match the string 'aa', and generates all permutations of the following string
			// [a|b]a[a|b]a[a|b]
			const matchingResult = vm.execute(createInput('aa'));
			chai.expect(matchingResult.success).to.equal(true, 'success');
			chai.expect(matchingResult.acceptingTraces.length).to.equal(1);

			// Sort the results of the traces since the order should be undefined
			chai.expect(flattenRecordStrings(matchingResult.acceptingTraces).sort()).to.deep.equal([
				'[a]a[a]a[a]',
				'[a]a[a]a[b]',
				'[a]a[b]a[a]',
				'[a]a[b]a[b]',
				'[b]a[a]a[a]',
				'[b]a[a]a[b]',
				'[b]a[b]a[a]',
				'[b]a[b]a[b]'
			]);
		});

		it('can specify possible extensions to the inputted string of length 3, in a language with star-height 2', () => {
			// Test case: running through outer star once
			const vm = compileRegexVM('(a*b*c)*', false);

			// This regex should match the string 'abc', and generates all permutations of the following string
			const matchingResult = vm.execute(createInput('abc'));
			chai.expect(matchingResult.success).to.equal(true, 'success');
			chai.expect(matchingResult.acceptingTraces.length).to.equal(1);

			// Sort the results of the traces since the order should be undefined
			chai.expect(flattenRecordStrings(matchingResult.acceptingTraces).sort()).to.deep.equal([
				'[a][b][c][a]a[a][b]b[b]c[a][b][c]'
			]);

			// Remark the individual explorations are not schema-valid, though the string may be completed using the previous example.
		});

		it('can specify possible extensions to the inputted string in a language with star-height 2, providing input that matches the outer star twice', () => {
			// Test case: running through the star twice
			const vm = compileRegexVM('(a*b*c)*', false);

			// This regex should match the string 'abc', and generates all permutations of the following string
			const matchingResult = vm.execute(createInput('aabbcaabbc'));
			chai.expect(matchingResult.success).to.equal(true, 'success');
			chai.expect(matchingResult.acceptingTraces.length).to.equal(1);

			// Sort the results of the traces since the order should be undefined
			chai.expect(flattenRecordStrings(matchingResult.acceptingTraces).sort()).to.deep.equal([
				'[a][b][c][a]a[a]a[a][b]b[b]b[b]c[a][b][c][a]a[a]a[a][b]b[b]b[b]c[a][b][c]'
			]);

			// Remark the individual explorations may not all be schema-valid, though the string may be completed using the previous example.
		});

		it('can specify possible extensions to the inputted string in a language with star-height 2, providing input matching the outer star thrice', () => {
			// Test case: running through the star thrice
			const vm = compileRegexVM('(a*b*c)*', false);

			// This regex should match the string 'abc', and generates all permutations of the following string
			const matchingResult = vm.execute(createInput('aabbcaabbcaabbc'));
			chai.expect(matchingResult.success).to.equal(true, 'success');
			chai.expect(matchingResult.acceptingTraces.length).to.equal(1);

			// Sort the results of the traces as the order should be undefined
			chai.expect(flattenRecordStrings(matchingResult.acceptingTraces).sort()).to.deep.equal([
				'[a][b][c][a]a[a]a[a][b]b[b]b[b]c[a][b][c][a]a[a]a[a][b]b[b]b[b]c[a][b][c][a]a[a]a[a][b]b[b]b[b]c[a][b][c]'
			]);

			// Remark the individual explorations may not all be schema-valid, though the string may be completed using the previous example.
		});
	});

	describe('greediness using badness', () => {
		it('provides ordering on badness over joined threads: greedy to start', () => {
			const vm = whynot.compileVM<string>(assembler => {
				// As a regex: roughly A*(.*), with the latter group in non-greedy capturing mode
				// Aims to match AAABBB to AAA(BBB) as opposed to either (AAABBB), A(AABBB), AA(ABBB), AAA(BBB)
				// A*
				const startIndex = 0;
				const start = assembler.jump([]);
				start.data.push(assembler.program.length);
				assembler.test(input => input === 'A');
				const endOfStar = assembler.jump([startIndex]);
				start.data.push(assembler.program.length);

				// Record position, to make a start of the CG
				assembler.record({}, (_, index) => index);

				// .*, non-greedy
				const start2Index = assembler.program.length;
				const start2 = assembler.jump([]);
				start2.data.push(assembler.program.length);
				assembler.bad();
				assembler.test(_input => true);
				assembler.jump([start2Index]);
				start2.data.push(assembler.program.length);

				// Done
				assembler.accept();
			});

			const result = vm.execute(createInput(['A', 'A', 'A', 'B', 'B', 'B']));
			//                                      0    1    2    3    4    5    6
			//                                                     '--- Expect CG to start here
			const firstRecord = (function findFirstRecord (trace: Trace): number {
				if (trace.records.length) {
					return trace.records[0];
				}

				return findFirstRecord(trace.prefixes[0]);
			})(result.acceptingTraces[0]);
			chai.expect(firstRecord).to.equal(3);
		});

		it('provides ordering on badness over joined threads, greedy to end', () => {
			const vm = whynot.compileVM<string>(assembler => {
				// As a regex: roughly .*(A*), with the latter group in non-greedy capturing mode
				// Aims to match BBBAAA to (BBB)AAA as opposed to either (BBBAAA), B(BBAA), BB(BAAA), (BBB)AAA

				// .*, non-greedy
				const start2Index = assembler.program.length;
				const start2 = assembler.jump([]);
				start2.data.push(assembler.program.length);
				assembler.bad();
				assembler.test(function (input: string) { 
					return true;
				});
				assembler.jump([start2Index]);
				start2.data.push(assembler.program.length);

				// Record position, to make a start of the CG
				assembler.record({}, function (_, index) {
					return index;
				});

				// A*
				const startIndex = assembler.program.length;
				const start = assembler.jump([]);
				start.data.push(assembler.program.length);
				assembler.test(function (input) { return input === 'A'; });
				const endOfStar = assembler.jump([startIndex]);
				start.data.push(assembler.program.length);

				// Done
				assembler.accept();
			});

			const result = vm.execute(createInput(['B', 'B', 'B', 'A', 'A', 'A']));
			//                                      0    1    2    3    4    5    6
			//                                                     '--- Expect CG to start here
			const firstRecord = (function findFirstRecord (trace: Trace): number {
				if (trace.records.length) {
					return trace.records[0];
				}

				return findFirstRecord(trace.prefixes[0]);
			})(result.acceptingTraces[0]);
			chai.expect(firstRecord).to.equal(3);
		});
	});
});
