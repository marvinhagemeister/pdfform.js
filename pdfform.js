if (typeof require != 'undefined') {
	var DOMParser = require('xmldom').DOMParser;
	var XMLSerializer = require('xmldom').XMLSerializer;
	var text_encoding = require('text-encoding');
	var TextEncoder = text_encoding.TextEncoder;
	var TextDecoder = text_encoding.TextDecoder;

	var pako = require('./libs/pako.min.js');
	var minipdf = require('./minipdf.js');
	// var minipdf = require('./pdf_js_compat.js');
}

var pdfform = (function() {
'use strict';

var assert = minipdf.assert;

function BytesIO() {
	this.length = 0;
	this.entries = [];
}
BytesIO.prototype = {
	write_str: function(s) {
		this.length += s.length;
		assert(typeof s == 'string');
		this.entries.push(s);
	},
	write_buf: function(buf) {
		this.length += buf.length;
		assert(buf instanceof Uint8Array, 'Expected a Uint8Array, but got ' + JSON.stringify(buf));
		this.entries.push(buf);
	},
	get_uint8array: function() {
		var res = new Uint8Array(this.length);
		var pos = 0;
		this.entries.forEach(function(e) {
			if (typeof e == 'string') {
				for (var i = 0,slen = e.length;i < slen;i++,pos++) {
					res[pos] = e.charCodeAt(i);
				}
			} else {
				res.set(e, pos);
				pos += e.length;
			}
		});
		assert(pos == this.length);
		return res;
	},
	position: function() {
		return this.length;
	},
};


// Code from pdf.utils.js (ASL2) starts here
function pad(num, length) {
  var ret = num + '';
  while (ret.length < length) {
	ret = '0' + ret;
  }
  return ret;
}

function hasSpecialChar(str) {
  for (var i = 0, ii = str.length; i < ii; i++) {
	switch (str[i]) {
	case '(':
	case ')':
	case '\\':
	case '\n':
	case '\r':
	case '\t':
	case '\b':
	case '\f':
		return true;
	}
  }
  return false;
}


function serialize(node, uncompressed) {
	var i, ret;  // Wishing for let in modern browsers :(
	if (minipdf.isRef(node)) {
		return node.num + ' ' + node.gen + ' R';
	} else if (minipdf.isNum(node)) {
		return node;
	} else if (minipdf.isBool(node)) {
		return node;
	} else if (minipdf.isName(node)) {
		assert(node.name);
		return '/' + node.name;
	} else if (minipdf.isString(node)) {
		if (!hasSpecialChar(node)) {
			return '(' + node + ')';
		} else {
			ret = '<';
			for (i = 0; i < node.length; i++) {
				ret += pad(node.charCodeAt(i).toString(16), 2);
			}
			return ret + '>';
		}
	} else if (minipdf.isArray(node)) {
		ret = ['['];
		for (i = 0; i < node.length; i++) {
			ret.push(serialize(node[i], uncompressed));
		}
		ret.push(']');
		return ret.join(' ');
	} else if (minipdf.isDict(node)) {
		var map = node.map;
		ret = ['<<'];
		for (var key in map) {
			ret.push('/' + key + ' ' + serialize(map[key], uncompressed));
		}
		ret.push('>>');
		return ret.join('\n');
	} else if (minipdf.isStream(node)) {
		ret = '';
		delete node.dict.map.DecodeParms;
		delete node.dict.map.Filter;

		var content = node.getBytes();
		assert(content, 'expecting byte content from ' + JSON.stringify(node));
		var out;
		if (uncompressed) {
			out = minipdf.buf2str(content);
			node.dict.map.Length = out.length;
		} else {
			out = minipdf.buf2str(pako.deflate(content));
			node.dict.map.Length = out.length;
			node.dict.map.Filter = [new minipdf.Name('FlateDecode')];
		}

		assert(minipdf.isDict(node.dict));
		ret += serialize(node.dict, uncompressed);
		ret += '\nstream\n';
		ret += out;
		ret += '\nendstream\n';
		return ret;
	} else {
		throw new Error('Unknown node type ' + JSON.stringify(node));
	}
  }

// End of code from pdf.utils.js

function PDFObjects(doc) {
	this.entries = doc.get_xref_entries();
	assert(minipdf.isArray(this.entries), 'xref entries should be an Array');
}
PDFObjects.prototype = {
add: function(obj, gen) {
	var e = {
		obj: obj,
		gen: gen,
		num: this.entries.length,
		uncompressed: 'added',
	};
	this.entries.push(e);
	return e;
},
update: function(ref, obj) {
	assert(ref.num !== undefined);
	assert(ref.gen !== undefined);
	var e = {
		obj: obj,
		gen: ref.gen,
		num: ref.num,
		uncompressed: 'added',
	};
	this.entries[e.num] = e;
	return e;
},
write_object: function(out, e, uncompressed) {
	e.offset = out.position();
	assert(e.num !== undefined);
	var bs = serialize(e.obj, uncompressed);
	out.write_str(e.num + ' ' + e.gen + ' obj\n');
	out.write_str(bs);
	out.write_str('\nendobj\n');
},
write_xref_stream: function(out, prev, root_ref) {
	var map = {
		Type: new minipdf.Name('XRef'),
		Size: this.entries.length + 1, // + 1 for this object itself
		Length: 6 * (this.entries.length + 1),
		Root: root_ref,
		W: [1, 4, 1],
	};
	if (prev !== undefined) {
		map.Prev = prev;
	}

	var bio = new BytesIO();
	var entry = this.add('__xref_stream__', 0);
	entry.offset = out.position();
	this.entries.forEach(function(e) {
		assert(e.offset !== undefined, 'entry should have an offset');
		bio.write_buf(new Uint8Array([
			(e.uncompressed ? 1 : 2),
			(e.offset >> 24),
			(e.offset >> 16) & 0xff,
			(e.offset >> 8) & 0xff,
			e.offset & 0xff,
			e.gen,
		]));
	});
	var ui8ar = bio.get_uint8array();

	var stream = minipdf.newStream(map, ui8ar);
	entry.obj = stream;
	this.write_object(out, entry, true);
},
};

function visit_acroform_fields(doc, callback) {
	var to_visit = doc.acroForm.map.Fields.slice();
	while (to_visit.length > 0) {
		var n = to_visit.shift();
		if (minipdf.isRef(n)) {
			var ref = n;
			n = doc.fetch(n);
			n._pdfform_ref = ref;
		}

		if (n.map && n.map.Kids) {
			to_visit.push.apply(to_visit, n.map.Kids);
		} else if (n.map && n.map.Type && n.map.Type.name == 'Annot') {
			callback(n);
		}
	}
}

function pdf_decode_str(str) {
	if (! str.startsWith('\u00FE\u00FF')) {
		return str;
	}
    var res = '';
	for (var i = 2; i < str.length; i += 2) {
		res += String.fromCharCode(str.charCodeAt(i) << 8 | str.charCodeAt(i + 1));
	}
	return res;
}

function acroform_match_spec(n, fields) {
	var t = pdf_decode_str(n.map.T);
	if (t in fields) {
		return fields[t][0];
	} else {
		var m = /^(.*)\[([0-9]+)\]$/.exec(t);
		if (m && (m[1] in fields)) {
			return fields[m[1]][m[2]];
		}
	}
	return undefined;
}

function modify_xfa(doc, objects, out, index, callback) {
	var xfa = doc.acroForm.map.XFA;
	var section_idx = xfa.indexOf(index);
	assert(section_idx >= 0);
	var section_ref = xfa[section_idx + 1];
	var section_node = doc.fetch(section_ref);
	assert(minipdf.isStream(section_node), 'XFA section node should be a stream');
	var bs = section_node.getBytes();
	assert(bs);
	var str = (new TextDecoder('utf-8')).decode(bs);

	str = callback(str);
 
	var out_bs = (new TextEncoder('utf-8').encode(str));
	var out_node = minipdf.newStream(section_node.dict.map, out_bs);
	assert(minipdf.isStream(out_node));

	var e = objects.update(section_ref, out_node);
	objects.write_object(out, e);
}

function transform(data, fields) {
	var doc = minipdf.parse(new Uint8Array(data));
	var objects = new PDFObjects(doc);

	var out = new BytesIO();
	out.write_buf(data);

	// Change AcroForms
	visit_acroform_fields(doc, function(n) {
		var spec = acroform_match_spec(n, fields);
		if (spec === undefined) {
			return;
		}

		if (n.map.FT.name == 'Tx') {
			n.map.V = '' + spec;
		} else if (n.map.FT.name == 'Btn') {
			n.map.AS = n.map.V = n.map.DV = spec ? new minipdf.Name('Yes') : new minipdf.Name('Off');
		} else {
			throw new Error('Unsupported input type' + n.map.FT.name);
		}

		var ref = n._pdfform_ref;
		var e = objects.update(ref, n);
		objects.write_object(out, e);
	});
	// Set NeedAppearances in AcroForm dict
	var acroform_ref = doc.get_acroform_ref();
	doc.acroForm.map.NeedAppearances = true;
	var e = objects.update(acroform_ref, doc.acroForm);
	objects.write_object(out, e);


	// Change XFA
	modify_xfa(doc, objects, out, 'datasets', function(str) {
		// Fix up XML
		str = str.replace(/\n(\/?>)/g, '$1\n');

		var ds_doc = new DOMParser().parseFromString(str);
		for (var f in fields) {
			var els = ds_doc.getElementsByTagName(f);

			for (var i = 0;i < els.length;i++) {
				var val = fields[f][i];
				if (val === undefined) {
					continue;
				}
				var el = els[i];
				while (el.firstChild) {
					el.removeChild(el.firstChild);
				}

				if (typeof val == 'boolean') {
					val = val ? 1 : 0;
				}
				el.appendChild(ds_doc.createTextNode(val));
			}
		}

		str = new XMLSerializer().serializeToString(ds_doc);
		return str;
	});

	var startxref = out.position();
	var root_id = doc.get_root_id();
	var root_ref = new minipdf.Ref(root_id, 0);
	objects.write_xref_stream(out, doc.startXRef, root_ref);

	out.write_str('startxref\n');
	out.write_str(startxref + '\n');
	out.write_str('%%EOF');

	return out.get_uint8array();
}

return {
	transform: transform,
};
})();

if (typeof module != 'undefined') {
	module.exports = pdfform;
}