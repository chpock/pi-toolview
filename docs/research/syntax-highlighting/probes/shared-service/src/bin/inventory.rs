// Registry presence only: not a conformance/embedding test.
use serde_json::json;
fn main(){
 let giallo=giallo::Registry::builtin().unwrap();
 let bat=bat::assets::HighlightingAssets::from_binary();
 let syntaxes=bat.get_syntax_set().unwrap();
 let requests=[("typescript","ts"),("tsx","tsx"),("javascript","js"),("python","py"),("rust","rs"),("shellscript","sh"),("go","go"),("java","java"),("cpp","cpp"),("csharp","cs"),("html","html"),("css","css"),("json","json"),("yaml","yaml"),("toml","toml"),("sql","sql"),("vue","vue"),("svelte","svelte"),("markdown","md"),("dockerfile","Dockerfile"),("makefile","Makefile")];
 let rows=requests.into_iter().map(|(id,ext)|json!({"canonicalRequest":id,"gialloPresent":giallo.contains_grammar(id),"batByExtension":syntaxes.find_syntax_by_extension(ext).map(|s|s.name.as_str()),"batByFilename":syntaxes.find_syntax_by_name(ext).map(|s|s.name.as_str())})).collect::<Vec<_>>();
 println!("{}",json!({"gialloVersion":"0.5.2","syntectVersion":"5.3.0","batVersion":"0.26.1","batSyntaxEntries":syntaxes.syntaxes().len(),"entries":rows}));
}
