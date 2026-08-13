'use strict';

const https = require('https');

const CACHE_TIME = 0;
let cache = {};

const STATIONS = {
    7: {name:"FIP Nationale"},
    64:{name:"FIP Jazz"},
    65:{name:"FIP Groove"},
    66:{name:"FIP Hip-Hop"},
    67:{name:"FIP Electro"},
    68:{name:"FIP Metal"},
    74:{name:"FIP Electro"}
};

function httpGet(url){
    return new Promise((resolve,reject)=>{
        https.get(url,{
            headers:{
                "User-Agent":"Volumio Radio FIP Plugin"
            }
        },res=>{
            let data="";
            res.on("data",d=>data+=d);
            res.on("end",()=>{
                if(res.statusCode!==200){
                    reject(new Error("HTTP "+res.statusCode));
                    return;
                }
                try{
                    resolve(JSON.parse(data));
                }catch(e){
                    reject(e);
                }
            });
        }).on("error",reject);
    });
}

async function fetchMetadata(id){
    let urls=[
        "https://api.radiofrance.fr/livemeta/pull/"+id,
        "https://api.radiofrance.fr/livemeta/pull/"+id+"?format=json"
    ];
    for(let url of urls){
        try{
            return await httpGet(url);
        }catch(e){}
    }
    throw new Error("No metadata endpoint");
}

function clean(v){
    if(!v)return "";
    return String(v)
        .replace(/^"+|"+$/g,"")
        .trim();
}

function flatten(obj,out,path){
    out=out||{};
    path=path||"";
    if(typeof obj!=="object"||obj===null)return out;
    Object.keys(obj).forEach(k=>{
        let p=path?path+"."+k:k;
        if(typeof obj[k]==="object"){
            flatten(obj[k],out,p);
        }else{
            out[p]=obj[k];
        }
    });
    return out;
}

function parseMetadata(json){

    let now = Math.floor(Date.now() / 1000);
    let current = null;

    if(json.steps){

        Object.keys(json.steps).forEach(k=>{

            let step = json.steps[k];

            if(step.start &&
               step.end &&
               step.start <= now &&
               now <= step.end){

                current = step;
            }

        });
    }

    if(!current){
        return {
            title:"",
            artist:"",
            album:"",
            label:"",
            image:""
        };
    }

    return {
        title: clean(current.title),

        artist:
            current.highlightedArtists &&
            current.highlightedArtists.length
            ? current.highlightedArtists.join(", ")
            : clean(current.authors),

        album: clean(current.titreAlbum),

        label: clean(current.label),

        image: clean(current.visual)
    };
}

async function getMetadata(id){
    let now=Date.now();

    if(cache[id] &&
       (now-cache[id].time)<CACHE_TIME){
        return cache[id].data;
    }

    try{
        let json=await fetchMetadata(id);
        let track=parseMetadata(json);

        let data={
            station:(STATIONS[id]&&STATIONS[id].name)||"FIP",
            title:track.title,
            artist:track.artist,
            album:track.album,
            label:track.label,
            albumart:track.image
        };

        cache[id]={
            time:now,
            data:data
        };

        return data;

    }catch(e){
        return {
            station:(STATIONS[id]&&STATIONS[id].name)||"FIP",
            title:"",
            artist:"",
            album:"",
            label:"",
            albumart:"",
            error:e.message
        };
    }
}

module.exports={
    getMetadata:getMetadata,
    STATIONS:STATIONS
};
