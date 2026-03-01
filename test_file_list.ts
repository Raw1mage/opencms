import { File } from "./packages/opencode/src/file";

async function main() {
    try {
        const res = await File.list("/home/pkcs12/projects");
        console.log("OK", JSON.stringify(res, null, 2));
    } catch (e) {
        console.error("ERROR", e.message);
    }
}

main();
