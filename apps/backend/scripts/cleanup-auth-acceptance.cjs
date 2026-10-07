// Operator-only cleanup after explicit live acceptance. Exact manifest on stdin; dry by default.
const { PrismaClient } = require('@prisma/client'); const prisma=new PrismaClient();
async function main(){
 let input='';for await(const chunk of process.stdin)input+=chunk;const s=JSON.parse(input);
 if(!/^security-\d+$/.test(s.prefix)||s.aEmail!==s.prefix+'-a@example.com'||s.bEmail!==s.prefix+'-b@example.com')throw new Error('Only the named disposable acceptance accounts may be cleaned.');
 const ids=[s.aId,s.bId];if(ids.some(id=>typeof id!=='string'||!/^[\da-f-]{36}$/i.test(id)))throw new Error('Exact disposable UUIDs required.');
 const users=await prisma.user.findMany({where:{id:{in:ids}}});if(users.length!==2||users.some(u=>u.role!=='USER'||![s.aEmail,s.bEmail].includes(u.email)))throw new Error('Account identity or role mismatch; cleanup refused.');
 const owned={userId:{in:ids}};
 for(const m of ['editProject','referenceAsset','savedStyle','editTemplate'])if(await prisma[m].count({where:owned}))throw new Error('Delete disposable content through its authenticated APIs before account cleanup.');
 const projects=await prisma.project.findMany({where:owned,include:{_count:{select:{videos:true,videoImports:true}}}});
 if(projects.some(p=>p._count.videos||p._count.videoImports))throw new Error('A disposable project still has content.');
 if(await prisma.creditReservation.count({where:{...owned,status:'RESERVED'}}))throw new Error('An accepted job still has a reservation; wait for settlement.');
 console.log('Verified exactly two disposable accounts, zero remaining content and zero live reservations.');
 if(!process.argv.includes('--apply'))return;
 await prisma.$transaction(async tx=>{await tx.project.deleteMany({where:owned});await tx.session.deleteMany({where:owned});await tx.creditTransaction.deleteMany({where:owned});await tx.creditReservation.deleteMany({where:owned});await tx.user.deleteMany({where:{id:{in:ids},role:'USER',email:{in:[s.aEmail,s.bEmail]}}});});
 if(await prisma.user.count({where:{id:{in:ids}}}))throw new Error('Cleanup verification failed.');
 console.log('Disposable accounts, empty projects, sessions and usage records removed. Admin audit entries retained.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>prisma.$disconnect());
