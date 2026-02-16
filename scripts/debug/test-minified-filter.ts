#!/usr/bin/env bun

// 測試：檢查 minified code 是否會被過濾

const testContent = `// Version: 2.1.37

// Want to see the unminified source? We're hiring!
// https://jobs.geckoboard.com/anthropic/jobs/4816109008
import*as Yq from"@anthropic-ai/sdk";import{createServer:var{getPrototypeOf:Yq,defineProperty:af1,getOwnPropertyNames:tua,getOwnPropertyDescriptor:Yyq}=Object,_Ua=Object.prototype.hasOwnProperty;var s=(A,q,k)=>{k=A!==null&&typeof A=="object"||typeof A=="function"?Xfr.get(A)||((Y,z)=>{Y.set(A,Y={value:{},writable:!0});return Y})()(Y,z)=>{get:()=>A[z],enumerable:!0}):return Y},$UA=new WeakMap,Iy=A=>{var q=$UA.get(A);if(q)return q;if(q=af1({},__esModule:{value:!0}),A&typeof A=="object"||typeof A=="function")UA(A).map((Y)=>Y&&afi(q,Y,`

console.log("測試 minified JavaScript 是否會被過濾...\n")

const lines = testContent.split("\n")
const totalChars = testContent.length
const totalLines = lines.length

function isHumanReadable(content) {
  const lines = content.split("\n")
  const totalChars = content.length

  // 規則 1: 過長內容
  if (lines.length > 50 || totalChars > 2000) {
    return { readable: false, reason: "too long" }
  }

  // 規則 2: Minified code 檢測（單行超長）
  const maxLineLength = Math.max(...lines.map((l) => l.length))
  if (maxLineLength > 500) {
    return { readable: false, reason: "minified code" }
  }

  // 規則 3: 多行超長檢測
  const longLines = lines.filter((l) => l.length > 200).length
  if (longLines > lines.length * 0.5) {
    return { readable: false, reason: "minified/obfuscated code" }
  }

  return { readable: true }
}

const result = isHumanReadable(testContent)
console.log(`總字元數: ${totalChars}`)
console.log(`總行數: ${totalLines}`)
console.log(`最長行: ${Math.max(...lines.map((l) => l.length))} 字元`)

console.log("\n結論:")
if (!result.readable) {
  console.log(`✅ 成功過濾！原因: ${result.reason}`)
} else {
  console.log("❌ 過濾失敗")
}
