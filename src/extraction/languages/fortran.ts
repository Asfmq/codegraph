import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, VariableInfo } from '../tree-sitter-types';

// Track nodes currently being extracted to prevent re-entrancy in visitFunctionBody.
// The core's visitFunctionBody checks functionTypes for nested functions, and when
// body === node (Fortran has no explicit body field), it would re-extract the same
// function and recurse infinitely. This set lets resolveName return <anonymous>
// during body visitation so the nested-function guard at visitFunctionBody:2155
// skips the re-extraction.
const extracting = new WeakSet<object>();

export const fortranExtractor: LanguageExtractor = {
  // Fortran free-form (.f90/.f95/.f03/.f08) and fixed-form (.f/.for/.ftn).
  // Fixed-form files may have partial errors on some F77 constructs (continuation
  // lines with '*', hollerith constants); the grammar still extracts most symbols.
  functionTypes: ['function', 'subroutine', 'procedure'],
  // module, program, derived_type_definition act as scope containers
  classTypes: ['module', 'program', 'derived_type_definition'],
  methodTypes: ['function', 'subroutine', 'procedure'],
  interfaceTypes: ['interface_block'],
  structTypes: [],
  enumTypes: ['enum_definition'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: [],
  importTypes: ['use_statement', 'include_statement'],
  callTypes: ['call_expression', 'subroutine_call'],
  variableTypes: ['variable_declaration'],
  fieldTypes: ['variable_declaration'], // fields inside derived_type_definition
  nameField: 'name',
  bodyField: 'body', // Fortran has no body field — core falls back to the node itself
  paramsField: 'parameters',
  returnField: 'function_result',

  // Resolve name for module/program/derived_type where the name lives in the
  // *_statement child, not directly on the node. The grammar is inconsistent:
  // function_statement has a named "name" field, but module_statement and
  // program_statement have an unnamed "name" node-type child instead.
  resolveName: (node, source) => {
    // Prevent re-entrant extraction: when visitFunctionBody encounters the
    // function node itself (body === node), functionTypes includes the node
    // type and the core would call extractFunction again → infinite recursion.
    // Return <anonymous> for nodes already being extracted (guarded by WeakSet
    // set in resolveBody) so the nested-function check skips them.
    if (extracting.has(node as unknown as object)) return '<anonymous>';

    // Helper: find a "name" node-type child in the statement (unnamed field fallback)
    const findNameByType = (parent: any) =>
      parent.namedChildren?.find((c: any) => c.type === 'name');

    if (node.type === 'function' || node.type === 'subroutine' || node.type === 'procedure') {
      const stmt = node.namedChildren.find(c =>
        c.type === 'function_statement' || c.type === 'subroutine_statement'
      );
      if (stmt) {
        const nameNode = getChildByField(stmt, 'name') || findNameByType(stmt);
        if (nameNode) return getNodeText(nameNode, source);
      }
    }
    if (node.type === 'module') {
      const stmt = node.namedChildren.find(c => c.type === 'module_statement');
      if (stmt) {
        const nameNode = getChildByField(stmt, 'name') || findNameByType(stmt);
        if (nameNode) return getNodeText(nameNode, source);
      }
    }
    if (node.type === 'program') {
      const stmt = node.namedChildren.find(c => c.type === 'program_statement');
      if (stmt) {
        const nameNode = getChildByField(stmt, 'name') || findNameByType(stmt);
        if (nameNode) return getNodeText(nameNode, source);
      }
    }
    if (node.type === 'derived_type_definition') {
      const stmt = node.namedChildren.find(c => c.type === 'derived_type_statement');
      if (stmt) {
        // type_name is an unnamed child node (not a field) — find by node type
        const nameNode = stmt.namedChildren.find((c: any) => c.type === 'type_name') ||
                         getChildByField(stmt, 'name') || findNameByType(stmt);
        if (nameNode) return getNodeText(nameNode, source);
      }
    }
    return undefined;
  },

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const resultVar = getChildByField(node, 'function_result');
    if (!params && !resultVar) return undefined;
    let sig = '';
    if (params) sig = getNodeText(params, source);
    if (resultVar) sig += ' result(' + getNodeText(resultVar, source) + ')';
    return sig || undefined;
  },

  getVisibility: (node) => {
    // Check if this is inside a module and whether it's listed in public/private
    let parent = node.parent;
    while (parent) {
      if (parent.type === 'module') {
        // Find private_statement / public_statement before the contains_statement
        for (let i = 0; i < parent.childCount; i++) {
          const child = parent.child(i);
          if (child?.type === 'private_statement') return 'private';
          if (child?.type === 'public_statement') return 'public';
        }
        // Fortran defaults to public in modules
        return 'public';
      }
      parent = parent.parent;
    }
    return undefined;
  },

  isExported: (_node, _source) => {
    // Fortran module procedures are public by default
    return true;
  },

  // Fortran variable_declaration can have multiple declarators
  // e.g. `real :: a, b, c` or `integer, parameter :: X = 1, Y = 2`
  extractVariables: (node, source) => {
    const vars: VariableInfo[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child || !child.isNamed) continue;
      // Skip type specifiers and attributes
      if (child.type === 'intrinsic_type' || child.type === 'derived_type' ||
          child.type === 'type_qualifier' || child.type === 'kind') continue;

      if (child.type === 'identifier') {
        vars.push({ name: getNodeText(child, source), kind: 'variable' });
      } else if (child.type === 'sized_declarator') {
        // array declarator: `a(5)` — name is the first identifier child
        const nameChild = child.namedChildren.find(c => c.type === 'identifier');
        if (nameChild) {
          vars.push({ name: getNodeText(nameChild, source), kind: 'variable' });
        }
      } else if (child.type === 'init_declarator') {
        // initialized: `X = 1` — name is the left-hand identifier
        const left = child.namedChild(0);
        if (left && left.type === 'identifier') {
          vars.push({ name: getNodeText(left, source), kind: 'variable' });
        }
      }
    }
    return vars;
  },

  isConst: (node) => {
    // Check for PARAMETER attribute
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'type_qualifier' && child.text.toUpperCase().includes('PARAMETER')) {
        return true;
      }
    }
    return false;
  },

  // Convert F77 fixed-form comment markers (C/c/* in column 1) to F90 `!`
  // comments. The tree-sitter-fortran grammar's external scanner doesn't
  // reliably handle traditional fixed-form comments, treating `C` as an
  // identifier and producing cascading ERROR nodes. `!` comments are
  // handled correctly across both formats. Only applied to fixed-form
  // extensions; free-form .f90/.f95/.f03/.f08 files are left untouched.
  preprocessSource: (source, filePath) => {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    if (!['.f', '.for', '.ftn', '.f77'].includes(ext)) return source;

    const lines = source.split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const first = line.charAt(0);
      if (first === 'C' || first === 'c' || first === '*') {
        lines[i] = '!' + line.substring(1);
        changed = true;
      }
    }
    return changed ? lines.join('\n') : source;
  },

  // Fortran has no explicit body field. Return node so extractFunction calls
  // visitFunctionBody (the core skips it when body is null, unlike extractClass
  // which falls back to body=node). A WeakSet guard in resolveName prevents the
  // re-entrant nested-function detection in visitFunctionBody:2155 from
  // re-extracting the same function during its own body visitation.
  resolveBody: (node) => {
    if (node.type === 'function' || node.type === 'subroutine' || node.type === 'procedure') {
      extracting.add(node);
      return node;
    }
    // For module/program: let the core extractClass handle the fallback
    return null;
  },

  extractImport: (node, source) => {
    if (node.type === 'use_statement') {
      // module_name is an unnamed child (node type, not a field) — find by type
      const moduleNameNode = node.namedChildren.find((c: any) => c.type === 'module_name');
      if (moduleNameNode) {
        return {
          moduleName: getNodeText(moduleNameNode, source),
          signature: getNodeText(node, source).replace(/\s+/g, ' ').trim(),
        };
      }
    }
    if (node.type === 'include_statement') {
      const filenameNode = node.namedChildren.find((c: any) => c.type === 'filename');
      if (filenameNode) {
        return {
          moduleName: getNodeText(filenameNode, source).replace(/['"]/g, ''),
          signature: getNodeText(node, source).replace(/\s+/g, ' ').trim(),
        };
      }
    }
    return null;
  },
};
