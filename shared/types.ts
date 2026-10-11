export type Faction = 'red' | 'green' | 'blue';
export type ItemType = 'resonator' | 'pulse' | 'cube' | 'key' | 'shield' | 'heatsink' | 'multihack';
export interface Point {x:number;y:number} // 权威坐标为整数厘米，展示时换算为米。
export interface Item {type:ItemType;level:number;portalId?:string;quantity:number;protected?:boolean}
export interface Resonator {level:number;energy:number;owner:string;ownerName?:string;x:number;y:number;generation:string;nextDecayAt:number}
export interface DroppedItem extends Point {id:string;item:Item;droppedAt:number}
export interface GroundXm extends Point {id:string;amount:number;spawnedAt:number;expiresAt:number}
export interface Mod {type:'shield'|'heatsink'|'multihack';owner:string}
export interface Portal extends Point {id:string;name:string;districtId:string;role?:string;faction:Faction|null;version:number;resonators:(Resonator|null)[];mods:(Mod|null)[]}
export interface Link {id:string;origin:string;destination:string;faction:Faction;owner:string}
export interface Field {id:string;vertices:[string,string,string];links:string[];faction:Faction;owner:string;mu:number;large:boolean}
export interface Movement {from:Point;to:Point;startAt:number;arriveAt:number}
export interface Player extends Point {id:string;name:string;faction:Faction|null;ap:number;xm:number;energyAt:number;energyRemainder:number;inventory:Item[];movement:Movement|null;cooldowns:Record<string,number>;hacks:Record<string,{times:number[];readyAt:number}>;version:number;createdAt:number;tutorial:Record<string,number>;rechargeRemainder:number;restrictedUntil:number}
export interface Season {id:number;startAt:number;endAt:number}
export interface LevelReward {level:number;items:Item[]}
export interface BattleEvent {id:string;at:number;faction:Faction;kind:'capture'|'link'|'field'|'field-destroyed'|'attack'|'score';actor?:string;portals:string[];amount?:number}
export interface World {battleEvents?:BattleEvent[];droppedItems?:DroppedItem[];groundXm?:GroundXm[];nextGroundXmAt?:number;seq:string;logicalAt:number;season:Season;nextCheckpoint:number;portals:Record<string,Portal>;links:Link[];fields:Field[];scores:Record<Faction,number>;maintenance:boolean;announcement:string}
export interface District {id:string;name:string;bounds:[number,number,number,number]}
export interface TerrainLine {points:Point[];halfWidth:number}
export interface MapData {version:string;width:number;height:number;districts:District[];spawns:({id:string;districtId:string}&Point)[];portals:Portal[];water:TerrainLine[];rails:TerrainLine[];centers:({districtId:string}&Point)[]}
export interface GameCommand {type:string;portalId?:string;payload:Record<string,unknown>}
export interface CommandContext {now:number;random:()=>number;id:()=>string;map:MapData}
export interface GameResult {world:World;player:Player;result:Record<string,unknown>;alerts?:{portalId:string;faction:Faction;owners:string[]}[]}
export interface DueResult {world:World;checkpoints:{seasonId:number;index:number;at:number;scores:Record<Faction,number>}[];seasons:{id:number;startAt:number;endAt:number;scores:Record<Faction,number>}[]}
export interface CommandEnvelope {commandEpoch:string;requestId:string;seasonId:number;rulesetVersion:string;mapVersion:string;playerVersion:number;targetVersion?:number;payload:Record<string,unknown>}
export interface Snapshot {world:World;player:Player;serverTime:number;rulesetVersion:string;mapVersion:string;map:MapData;csrfToken:string;commandEpoch:string}
