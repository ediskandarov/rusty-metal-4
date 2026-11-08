/* Exercise create-a-car through the original editor and memory-card UI. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const weapon=Number(process.env.TM4_TEST_CREATED_WEAPON??1);
const size=Number(process.env.TM4_TEST_CREATED_SIZE??1);
assert(weapon>=0&&weapon<4&&size>=0&&size<3);
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:960,height:800}});
 const errors=[];
 page.on('pageerror',e=>{errors.push(String(e));console.error(e);});
 page.on('console',m=>{if(m.type()==='error'&&!/^\[[ID]\]/.test(m.text())){errors.push(m.text());console.error(m.text());}});
 const state=()=>page.evaluate(()=>globalThis.tm4Port);
 const press=async key=>{await page.keyboard.down(key);await page.waitForTimeout(150);await page.keyboard.up(key);await page.waitForTimeout(150);};
 const screen=async name=>{await page.waitForFunction(name=>globalThis.tm4Port?.screen===name&&tm4Port.menuReady,name,{timeout:30000});assert.deepEqual(errors,[]);console.log('SCREEN',name);};
 try{
  await page.goto('http://127.0.0.1:8080/');await require('./browser_startup.cjs')(page);await screen('main');await page.locator('canvas').click();
  await press('x');await screen('newgame');await press('x');await screen('carsel');
  await press('ArrowDown');await press('x');await screen('ccdesign');
  await page.screenshot({path:'build/web/created-car-design.png'});
  for(let i=0;i<size;i++)await press('ArrowRight');
  await press('ArrowDown');await press('ArrowRight'); // second style
  await press('ArrowDown');await press('ArrowRight'); // second paint
  await press('ArrowDown');await press('ArrowRight'); // body option
  await press('x');await screen('ccweapon');for(let i=0;i<weapon;i++)await press('ArrowRight');await press('x');
  await screen('ccbtlcry');await press('ArrowRight');await press('x');
  await screen('cctype');
  await press('x'); // A
  await press('ArrowLeft');await press('ArrowUp');await press('x'); // END
  await page.waitForFunction(()=>tm4Port.dialog==='SAVE THIS CAR\nTO MEMORY CARD?');
  if(process.env.TM4_TEST_NO_SAVE){await press('ArrowLeft');await press('x');}
  else {
   await press('x');await screen('ccsave');await press('x');
   await page.waitForFunction(()=>tm4Port.dialog==='SAVE COMPLETE!',null,{timeout:15000});
  }
  await page.waitForFunction(()=>tm4Port.screen==='level'&&tm4Port.levelFrames>30,null,{timeout:30000});
  const loaded=await state();assert.equal(loaded.car,'A');assert(loaded.carAlive&&loaded.carPacketBytes>0);
  await page.screenshot({path:'build/web/created-car-driving.png'});
  console.log('Created car',loaded.car,loaded.weaponName);
  await page.keyboard.down('x');await page.waitForTimeout(1500);await page.keyboard.up('x');
  const driven=await state();assert(Math.hypot(driven.carX-loaded.carX,driven.carZ-loaded.carZ)>100);
  await press('w');await page.waitForFunction(({before,weapon})=>tm4Port.weaponAmmo<before.weaponAmmo&&(weapon===1
   ?tm4Port.lastRay==='laser'&&tm4Port.raySpawns>(before.raySpawns||0)
   :tm4Port.lastProjectile===['Funny','', 'Detno','Torch'][weapon]&&tm4Port.projectileSpawns>(before.projectileSpawns||0)),{before:driven,weapon},{timeout:5000});
  if(weapon===3)assert((await state()).projectileSpawns>=(driven.projectileSpawns||0)+2);
  assert.deepEqual(errors,[]);console.log('PASS original created-car physics and special',loaded.weaponName);
  if (process.env.TM4_TEST_CREATED_PROGRESSION) {
   const match=()=>page.evaluate(()=>{Module._WebTestReadMatchState();return tm4Port.match;});
   const deadline=Date.now()+45000;
   while(!(await match()).acceptsInput&&Date.now()<deadline){
    await page.evaluate(()=>Module._WebTestDefeatOpponents());await page.waitForTimeout(500);
    assert.deepEqual(errors,[]);
   }
   assert((await match()).won&&(await match()).acceptsInput);
   await press('x');
   await page.waitForFunction(()=>tm4Port.screen==='level'&&tm4Port.level==='Neon City'&&tm4Port.levelFrames>30,null,{timeout:30000});
   const next=await state();assert.equal(next.car,'A');assert.equal(next.weaponName,loaded.weaponName);
   assert(next.carAlive&&next.cameraAttached&&next.carPacketBytes>0);
   console.log('PASS created car retained across tournament world transition');
  }
  if (!process.env.TM4_TEST_NO_SAVE) {
   const saved=await page.evaluate(()=>localStorage.getItem('tm4.memory-card.0'));
   assert(saved&&Buffer.from(saved,'base64').length===128*1024);
   await press('Enter');await page.waitForFunction(()=>tm4Port.paused);
   await press('ArrowUp');await press('x');await press('ArrowUp');await press('x');await screen('main');
   await page.reload();await require('./browser_startup.cjs')(page);await screen('main');await page.locator('canvas').click();
   await press('x');await screen('newgame');await press('x');await screen('carsel');
   await press('ArrowDown');await press('ArrowDown');await press('x');await screen('ccload');
   await press('x');await page.waitForFunction(()=>tm4Port.screen==='level'&&tm4Port.levelFrames>30,null,{timeout:30000});
   const restored=await state();assert.equal(restored.car,'A');assert.equal(restored.weaponName,loaded.weaponName);
   assert(restored.carAlive&&restored.cameraAttached&&restored.carPacketBytes>0);
   assert.deepEqual(errors,[]);console.log('PASS original car save -> page reload -> load -> gameplay');
  }
 }catch(e){console.log('FAIL STATE',await state());await page.screenshot({path:'build/web/created-car-failure.png'});throw e;}
 finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
