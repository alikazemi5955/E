import shutil

with open("public/assets/index-C-RfPvmH.js", "r", encoding="utf-8") as f:
    js = f.read()

target = 'const suppName = isKasra ? "کسری پلاس" : "پازل کالا";'
idx = js.find(target)
if idx != -1:
    start = js.rfind('e.jsxDEV("td",{className:"py-2 px-1 text-center border-l border-slate-200/70",children:(()=>{', 0, idx)
    end = js.find('})()},void 0,!1,{},void 0)', idx) + len('})()},void 0,!1,{},void 0)')

    new_td = """e.jsxDEV("td",{className:"py-2 px-1 text-center border-l border-slate-200/70",children:(()=>{let suppName=L.referenceSupplierName||L.supplierName;if(!suppName&&L.supplierMatches){if(L.supplierMatches.kasra)suppName="کسری پلاس";else if(L.supplierMatches.hamrahtel)suppName="همراه تل";else{const keys=Object.keys(L.supplierMatches);if(keys.length>0)suppName=L.supplierMatches[keys[0]].supplierName||keys[0];}}if(!suppName){suppName=(String(L.id).startsWith("kasra-")||L.source==="kasraplus"||L.sourceProductId)?"کسری پلاس":"پازل کالا (تأمین داخلی)";}let cleanSuppName=suppName;if(suppName.includes("کسری")||suppName.toLowerCase().includes("kasra"))cleanSuppName="کسری پلاس";else if(suppName.includes("همراه")||suppName.toLowerCase().includes("hamrah"))cleanSuppName="همراه تل";else if(suppName.includes("پازل")||suppName.includes("داخلی"))cleanSuppName="پازل کالا (داخلی)";const isKasra=cleanSuppName==="کسری پلاس";const isHamrah=cleanSuppName==="همراه تل";const suppUrl=isKasra?(L.sourceUrl||(L.sourceSlug?("https://plus.kasrapars.ir/product/"+L.sourceSlug):"https://plus.kasrapars.ir")):isHamrah?"https://hamrahtel.com":(window.location.origin+"/#product-"+L.id);const badgeCls=isKasra?"bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200":isHamrah?"bg-sky-50 hover:bg-sky-100 text-sky-700 border-sky-200":"bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200";const dotCls=isKasra?"bg-indigo-500 animate-pulse":isHamrah?"bg-sky-500 animate-pulse":"bg-emerald-500";return e.jsxDEV("button",{type:"button",onClick:()=>{try{window.open(suppUrl,"_blank");}catch(e){}if(typeof window!=="undefined"&&window.__openSupplierModal){window.__openSupplierModal({supplierName:cleanSuppName,url:suppUrl,productName:L.persianName,id:L.id});}},className:"inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold transition-all cursor-pointer border shadow-2xs "+badgeCls,title:"تأمین‌کننده مرجع استعلام قیمت در لحظه: "+cleanSuppName,children:[e.jsxDEV("span",{className:"w-1.5 h-1.5 rounded-full "+dotCls},void 0,!1,{},void 0),cleanSuppName]},void 0,!0,{},void 0);})()},void 0,!1,{},void 0)"""

    js = js[:start] + new_td + js[end:]
    print("Replaced supplier td.")
else:
    print("Target already replaced or not found.")

old_dropdown = 'e.jsxDEV("select",{value:suppFilter,onChange:L=>setSuppFilter(L.target.value),className:"w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 font-bold",children:[e.jsxDEV("option",{value:"all",children:"همه تامین‌کنندگان"},void 0,!1,{},void 0),e.jsxDEV("option",{value:"kasra",children:"کسری پلاس"},void 0,!1,{},void 0),e.jsxDEV("option",{value:"puzzle",children:"پازل کالا"},void 0,!1,{},void 0)]},void 0,!0,{},void 0)'
new_dropdown = 'e.jsxDEV("select",{value:suppFilter,onChange:L=>setSuppFilter(L.target.value),className:"w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 font-bold",children:[e.jsxDEV("option",{value:"all",children:"همه تأمین‌کنندگان"},void 0,!1,{},void 0),e.jsxDEV("option",{value:"kasra",children:"کسری پلاس"},void 0,!1,{},void 0),e.jsxDEV("option",{value:"hamrahtel",children:"همراه تل"},void 0,!1,{},void 0),e.jsxDEV("option",{value:"puzzle",children:"پازل کالا (تأمین داخلی)"},void 0,!1,{},void 0)]},void 0,!0,{},void 0)'

if old_dropdown in js:
    js = js.replace(old_dropdown, new_dropdown, 1)
    print("Replaced supplier filter dropdown.")

old_filter_logic = 'const isK=String(Ne.id).startsWith("kasra-")||Ne.source==="kasraplus";let sM=!0;if(suppFilter==="kasra")sM=isK;else if(suppFilter==="puzzle")sM=!isK;'
new_filter_logic = 'const refSup=(Ne.referenceSupplierName||Ne.supplierName||(Ne.supplierMatches&&Ne.supplierMatches.kasra?"کسری پلاس":"")||"پازل کالا").toLowerCase();let sM=!0;if(suppFilter==="kasra")sM=refSup.includes("کسری")||refSup.includes("kasra");else if(suppFilter==="hamrahtel")sM=refSup.includes("همراه")||refSup.includes("hamrah");else if(suppFilter==="puzzle")sM=refSup.includes("پازل")||refSup.includes("puzzle")||refSup.includes("داخلی");'

if old_filter_logic in js:
    js = js.replace(old_filter_logic, new_filter_logic, 1)
    print("Replaced supplier filter logic.")

with open("public/assets/index-C-RfPvmH.js", "w", encoding="utf-8") as f:
    f.write(js)

shutil.copyfile("public/assets/index-C-RfPvmH.js", "dist/assets/index-C-RfPvmH.js")
print("Done writing to public and dist assets.")
