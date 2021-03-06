const rp = require("request-promise-native");
const _ = require("lodash");
const Discord = require("discord.js");
const log = require("log4js").getLogger('card');
const cheerio = require("cheerio");

class MtgCardLoader {
    constructor() {
        this.commands = {
            card: {
                aliases: [],
                inline: true,
                description: "Search for an English Magic card by (partial) name, supports full Scryfall syntax",
                help: '',
                examples: ["!card iona", "!card t:creature o:flying", "!card goyf e:fut"]
            },
            price: {
                aliases: ["prices"],
                inline: true,
                description: "Show the price in USD, EUR and TIX for a card",
                help: '',
                examples: ["!price tarmogoyf"]
            },
            ruling: {
                aliases: ["rulings"],
                inline: true,
                description: "Show the Gatherer rulings for a card",
                help: '',
                examples: ["!ruling sylvan library"]
            },
            legal: {
                aliases: ["legality"],
                inline: true,
                description: "Show the format legality for a card",
                help: '',
                examples: ["!legal divining top"]
            }
        };
        this.cardApi = "https://api.scryfall.com/cards/search?q=";
        this.cardApiFuzzy = "https://api.scryfall.com/cards/named?fuzzy=";
        // Discord bots can use custom emojis globally, so we just reference these Manamoji through their code / ID
        // (currently hosted on the Judgebot testing discord)
        // @see https://github.com/scryfall/thopter/tree/master/manamoji
        this.manamojis = {
            "0":"344491158384410625",
            "1":"344491158723887107",
            "10":"344491160280104984",
            "11":"344491159965401088",
            "12":"344491160435163137",
            "13":"344491160674238464",
            "14":"344491160619712513",
            "15":"344491160586289154",
            "16":"344491160808587264",
            "17":"344491160468979714",
            "18":"344491160720506880",
            "19":"344491160498208771",
            "2":"344491158371696641",
            "20":"344491161257246720",
            "2b":"344491158665429012",
            "2g":"344491159189585921",
            "2r":"344491159265083392",
            "2u":"344491159160225792",
            "2w":"344491159692771328",
            "3":"344491159210688522",
            "4":"344491159172677632",
            "5":"344491158883532801",
            "6":"344491159185260554",
            "7":"344491159021813761",
            "8":"344491159424466945",
            "9":"344491159273472020",
            "b":"344491161437732864",
            "bg":"344491161286737921",
            "bp":"344491161466961920",
            "br":"344491161362366465",
            "c":"344491160636489739",
            "chaos":"344491160267653130",
            "e":"344491160829558794",
            "g":"344491161169428481",
            "gp":"344491161102319616",
            "gu":"344491161223692300",
            "gw":"344491161139937282",
            "half":"344491161164972032",
            "hr":"344491160787615748",
            "hw":"344491161181749268",
            "infinity":"344491160619843593",
            "q":"344491161060245504",
            "r":"344491161274023938",
            "rg":"344491161295257600",
            "rp":"344491161076891648",
            "rw":"344491161316098049",
            "s":"343519207608025090",
            "t":"344491161089736704",
            "u":"344491161362235394",
            "ub":"344491161248858113",
            "up":"344491161395789824",
            "ur":"344491161534070784",
            "w":"344491161567887360",
            "wb":"344491161374818304",
            "wp":"344491161492258816",
            "wu":"344491161441796098",
            "x":"344491161345327126",
            "y":"344491161374818305",
            "z":"344491161035210755"
        };
        // embed border colors depending on card color(s)
        this.colors = {
            "W": 0xF8F6D8,
            "U": 0xC1D7E9,
            "B": 0x0D0F0F,
            "R": 0xE49977,
            "G": 0xA3C095,
            "GOLD": 0xE0C96C,
            "ARTIFACT": 0x90ADBB,
            "LAND": 0xAA8F84,
            "NONE": 0xDAD9DE
        };
        // cache for Discord permission lookup
        this.permissionCache = {};
        // cache for Card lookup
        this.cardCache = {};
        this.cardCacheDict = [];
        this.cardCacheLimit = 100;
    }

    getCommands() {
        return this.commands;
    }

    // replace mana and other symbols with actual emojis
    renderEmojis(text) {
        return text.replace(/{[^}]+?}/ig, match => {
            const code = match.replace(/[^a-z0-9]/ig,'').toLowerCase();
            return this.manamojis[code] ?  '<:'+(code.length < 2 ? code+'_':code)+':'+this.manamojis[code]+'>':'';
        });
    }

    // determine embed border color
    getBorderColor(card) {
        let color;
        if (!card.colors || card.colors.length === 0) {
            color = this.colors.NONE;
            if (card.type_line && card.type_line.match(/artifact/i)) color = this.colors.ARTIFACT;
            if (card.type_line && card.type_line.match(/land/i)) color = this.colors.LAND;
        } else if (card.colors.length > 1) {
            color = this.colors.GOLD;
        } else {
            color = this.colors[card.colors[0]];
        }
        return color;
    }

    // parse Gatherer rulings
    parseGathererRulings(gatherer) {
        const $ = cheerio.load(gatherer);
        const rulings = [];
        $('.rulingsTable tr').each((index,elem) => {
            rulings.push('**'+$(elem).find('td:nth-child(1)').text()+':** '+$(elem).find('td:nth-child(2)').text());
            if (rulings.join('\n').length > 2040) {
                rulings[rulings.length - 1] = '...';
                return false;
            }
        });
        return rulings.join('\n');
    }

    // generate description text from a card object
    generateDescriptionText(card) {
        const ptToString = (card) =>
            '**'+card.power.replace(/\*/g, '\\*') + "/" + card.toughness.replace(/\*/g, '\\*')+'**';

        const description = [];
        if (card.type_line) { // bold type line
            description.push('**'+card.type_line+'** ('+card.set.toUpperCase()+' '+_.capitalize(card.rarity)+')');
        }
        if (card.oracle_text) { // reminder text in italics
            description.push(card.oracle_text.replace(/[()]/g, m => m === '(' ? '*(':')*'));
        }
        if (card.flavor_text) { // flavor text in italics
            description.push('*' + card.flavor_text+'*');
        }
        if (card.loyalty) { // bold loyalty
            description.push('**Loyalty: ' + card.loyalty+'**');
        }
        if (card.power) { // bold P/T
            description.push(ptToString(card));
        }
        if (card.card_faces) {
            // split cards are special
            card.card_faces.forEach(face => {
                description.push('**'+face.type_line+'**');
                if (face.oracle_text) {
                    description.push(face.oracle_text.replace(/[()]/g, m => m === '(' ? '*(':')*'));
                }
                if (face.power) {
                    description.push(ptToString(face));
                }
                description.push('');
            });
        }
        return description.join('\n');
    }

    // generate the embed card
    generateEmbed(cards, command, hasEmojiPermission) {
        return new Promise(resolve => {
            const card = cards[0];

            // generate embed title and description text
            let title = card.name;

            if (card.mana_cost) {
                title += ' ' + card.mana_cost;
            }

            // DFC use card_faces array for each face
            if (card.layout === 'transform' && card.card_faces) {
                if (card.card_faces[0].mana_cost) {
                    title += ' ' + card.card_faces[0].mana_cost;
                }
                card.image_uris = card.card_faces[0].image_uris;
            }

            let description = this.generateDescriptionText(card);

            // are we allowed to use custom emojis? cool, then do so, but make sure the title still fits
            if(hasEmojiPermission) {
                title = _.truncate(this.renderEmojis(title), {length: 256, separator: '<'});
                description = this.renderEmojis(description);
            }

            // footer
            let footer = "Use !help to get a list of available commands.";
            if(cards.length > 1) {
                footer = (cards.length - 1) + ' other hits:\n';
                footer += cards.slice(1,6).map(cardObj => cardObj.name).join('; ');
                if (cards.length > 6) footer += '; ...';
            }

            // instantiate embed object
            const embed = new Discord.RichEmbed({
                title,
                description,
                footer: {text: footer},
                url: card.scryfall_uri,
                color: this.getBorderColor(card.layout === 'transform' ? card.card_faces[0]:card),
                thumbnail: {url: card.image_uris.small},
                image: card.zoom ? {url: card.image_uris.normal} : null
            });

            // add pricing, if requested
            if (command.match(/^price/)) {
                let prices = [];
                if(card.usd) prices.push('$' + card.usd);
                if(card.eur) prices.push(card.eur + '€');
                if(card.tix) prices.push(card.tix + ' Tix');
                embed.addField('Prices', prices.join(' / ') || 'No prices found');
            }

            // add legalities, if requested
            if (command.match(/^legal/)) {
                const legalities = (_.invertBy(card.legalities).legal || []).map(_.capitalize).join(', ');
                embed.addField('Legal in', legalities || 'Nowhere');
            }

            // add rulings loaded from Gatherer, if needed
            if(command.match(/^ruling/) && card.related_uris.gatherer) {
                rp(card.related_uris.gatherer).then(gatherer => {
                    embed.setAuthor('Gatherer rulings for');
                    embed.setDescription(this.parseGathererRulings(gatherer));
                    resolve(embed);
                });
            } else {
                resolve(embed);
            }
        });
    }

    // fetch permissions from Guild to use custom emojis
    getEmojiPermission(msg) {
        return new Promise(resolve => {
            if (msg.guild && this.permissionCache[msg.guild.id] === undefined) {
                // in guild chat, fetch member role
                msg.guild.fetchMember(msg.client.user.id).then(member => {
                    if (member.permissions) {
                        this.permissionCache[msg.guild.id] = member.permissions.has('USE_EXTERNAL_EMOJIS');
                        resolve(this.permissionCache[msg.guild.id]);
                    } else {
                        resolve(true);
                    }
                });
            } else if(msg.guild) {
                // in guild chat, permission is cached
                resolve(this.permissionCache[msg.guild.id])
            } else {
                // otherwise assume we can use custom emoji
                resolve(true);
            }
        });
    }

    // fetch the cards from Scryfall and cache them
    getCards(cardName) {
        let requestPromise;
        if (this.cardCache[cardName]) {
            // cache hit
            requestPromise = new Promise(resolve => resolve(this.cardCache[cardName]));
        } else {
            // ask Scryfall
            requestPromise = new Promise((resolve, reject) => {
                rp({url: this.cardApi + encodeURIComponent(cardName + ' include:extras'), json: true}).then(response => {
                    if (response.data) {
                        // if cache is too big, remove the oldest entry
                        if (this.cardCacheDict.length >= this.cardCacheLimit) {
                            delete this.cardCache[this.cardCacheDict.shift()];
                        }
                        // cache results
                        this.cardCache[cardName] = response;
                        this.cardCacheDict.push(cardName);
                    }
                    resolve(response);
                }, () => {
                    log.info('Falling back to fuzzy search for '+cardName);
                    rp({url: this.cardApiFuzzy + encodeURIComponent(cardName), json: true})
                        .then(response => resolve({data: [response]}), reject);
                });
            });
        }
        return requestPromise;
    }

    handleMessage(command, parameter, msg) {
        const cardName = parameter.toLowerCase();
        // no card name, no lookup
        if (!cardName) return;
        // fetch data from API and Discord Guild
        return Promise.all([
            this.getCards(cardName),
            this.getEmojiPermission(msg)
        ]).then(([body, permission]) => {
            // check if there are results
            if (body.data && body.data.length) {
                // generate embed
                this.generateEmbed(body.data, command, permission).then(embed => {
                    return msg.channel.send('', {embed});
                }, err => log.error(err)).then(sentMessage => {
                    // add reactions for zoom and paging
                    sentMessage.react('🔍').then(() => {
                        if (body.data.length > 1) {
                            sentMessage.react('⬅').then(() => sentMessage.react('➡'));
                        }
                    });
                    sentMessage.createReactionCollector(
                        ({emoji} , user) => ['⬅','➡','🔍'].indexOf(emoji.toString()) > -1 && user.id === msg.author.id,
                        {time: 60000, max: 20}
                    ).on('collect', reaction => {
                        if(reaction.emoji.toString() === '⬅') {
                            body.data.unshift(body.data.pop());
                        } else if(reaction.emoji.toString() === '➡') {
                            body.data.push(body.data.shift());
                        } else {
                            // toggle zoom
                            body.data[0].zoom = !body.data[0].zoom;
                        }
                        // edit the message to update the current card
                        this.generateEmbed(body.data, command, permission).then(embed => {
                            sentMessage.edit('', {embed});
                        });
                    });
                }, err => log.error(err));
            }
        }, (err) => {
            let description = 'No cards matched `'+cardName+'`.';
            if (err.statusCode === 503) {
                description = 'Scryfall is currently offline, please try again later.'
            }
            return msg.channel.send('', {embed: new Discord.RichEmbed({
                title: 'Error',
                description,
                color: 0xff0000
            })});
        });
    }
}

module.exports = MtgCardLoader;
